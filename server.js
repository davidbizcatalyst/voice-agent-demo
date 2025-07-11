require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const speech = require('@google-cloud/speech');
const textToSpeechClient = require('@google-cloud/text-to-speech');
const axios = require('axios');
const jsforce = require('jsforce');

// Initialize Google Cloud clients with cloud-friendly credential handling
let speechClient, ttsClient;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    // Cloud environment - credentials from environment variable
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    speechClient = new speech.SpeechClient({ credentials });
    ttsClient = new textToSpeechClient.TextToSpeechClient({ credentials });
} else {
    // Local environment - use default credential discovery
    speechClient = new speech.SpeechClient();
    ttsClient = new textToSpeechClient.TextToSpeechClient();
}

// Logging configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'verbose'; // 'verbose' or 'terse'

// Logging helper functions
function logVerbose(...args) {
    if (LOG_LEVEL === 'verbose') {
        console.log(...args);
    }
}

function logTerse(...args) {
    console.log(...args);
}

function logError(...args) {
    console.error(...args);
}

// Salesforce configuration
const SALESFORCE_CONFIG = {
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL || 'https://bl1750324360581.my.salesforce.com',
    clientId: process.env.SALESFORCE_CLIENT_ID,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    username: process.env.SALESFORCE_USERNAME,
    password: process.env.SALESFORCE_PASSWORD,
    agentId: process.env.SALESFORCE_AGENT_ID,
};

// Global variables for Salesforce connection with improved management
let accessToken = null;
let tokenExpiresAt = null;
let isRefreshingToken = false;

const app = express();
const server = require('http').createServer(app);

// Serve static files for the web interface
app.use(express.static('public'));

// Add health check endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        salesforceConnected: !!accessToken,
        tokenExpiry: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null
    });
});

// Keep service awake with periodic health checks
if (process.env.RAILWAY_ENVIRONMENT) {
    const keepAliveInterval = setInterval(async () => {
        try {
            // Ping ourselves to prevent Railway from sleeping
            const response = await fetch(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`);
            logVerbose('🏓 Keep-alive ping successful');
        } catch (error) {
            logVerbose('🏓 Keep-alive ping failed:', error.message);
        }
    }, 25 * 60 * 1000); // Every 25 minutes
}

// Generate unique session IDs
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Improved Salesforce connection with token refresh
async function ensureValidSalesforceToken() {
    // Check if token is still valid (with 5 minute buffer)
    if (accessToken && tokenExpiresAt && Date.now() < (tokenExpiresAt - 5 * 60 * 1000)) {
        return accessToken;
    }
    
    // Prevent multiple simultaneous refresh attempts
    if (isRefreshingToken) {
        logVerbose('🔄 Token refresh already in progress, waiting...');
        // Wait for the ongoing refresh to complete
        while (isRefreshingToken) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return accessToken;
    }
    
    isRefreshingToken = true;
    
    try {
        logTerse('🔄 Refreshing Salesforce token...');
        
        if (!SALESFORCE_CONFIG.clientId || !SALESFORCE_CONFIG.clientSecret) {
            throw new Error('Missing Salesforce credentials in environment variables');
        }
        
        const tokenUrl = `${SALESFORCE_CONFIG.instanceUrl}/services/oauth2/token`;
        const tokenResponse = await axios.post(tokenUrl, null, {
            params: {
                grant_type: 'client_credentials',
                client_id: SALESFORCE_CONFIG.clientId,
                client_secret: SALESFORCE_CONFIG.clientSecret,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000
        });
        
        accessToken = tokenResponse.data.access_token;
        // Salesforce tokens typically last 2 hours, but we'll be conservative
        tokenExpiresAt = Date.now() + (90 * 60 * 1000); // 90 minutes from now
        
        logTerse('✅ Salesforce token refreshed successfully');
        return accessToken;
        
    } catch (error) {
        logError('❌ Salesforce token refresh failed:', error.message);
        accessToken = null;
        tokenExpiresAt = null;
        throw error;
    } finally {
        isRefreshingToken = false;
    }
}

// Initialize Salesforce connection on startup
async function initializeSalesforce() {
    try {
        logTerse('🔄 Initializing Salesforce connection...');
        await ensureValidSalesforceToken();
        logTerse('✅ Salesforce initialization successful!');
        return true;
    } catch (error) {
        logError('❌ Salesforce initialization failed:', error.message);
        logTerse('Running in demo mode. Check your environment variables.');
        return false;
    }
}

// Convert text to speech (British English)
async function textToSpeech(text) {
    try {
        const request = {
            input: { text: text },
            voice: {
                languageCode: 'en-GB',
                ssmlGender: 'FEMALE',
            },
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: 1.0,
                pitch: 0.0,
            },
        };
        
        const [response] = await ttsClient.synthesizeSpeech(request);
        return response.audioContent;
    } catch (error) {
        logError('❌ Text-to-speech error:', error.message);
        throw error;
    }
}

// Initialize Salesforce on startup
initializeSalesforce();

// WebSocket server for real-time voice communication
const wss = new WebSocket.Server({ server });

// Track active connections for debugging
let activeConnections = 0;

wss.on('connection', (ws) => {
    activeConnections++;
    const connectionId = generateSessionId();
    logTerse(`🔗 New client connected (ID: ${connectionId.slice(-8)}, Total: ${activeConnections})`);
    
    let recognizeStream = null;
    let isStreamActive = false;
    
    // Session persistence - one session per WebSocket connection
    let agentSessionId = null;
    let messagesURL = null;
    let sequenceId = 1; // Track message sequence for conversation context
    
    // Complete transcript accumulation
    let completeTranscript = '';
    let lastInterimTranscript = ''; // Keep track of the last interim result
    let isRecording = false;
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'start') {
                logVerbose('🎤 Recording started');
                startSpeechRecognition(ws);
                isRecording = true;
                completeTranscript = ''; // Reset transcript for new recording
                lastInterimTranscript = ''; // Reset interim tracking
            } else if (data.type === 'audio') {
                if (recognizeStream && isStreamActive && !recognizeStream.destroyed) {
                    try {
                        const audioBuffer = Buffer.from(data.audio, 'base64');
                        recognizeStream.write(audioBuffer);
                    } catch (error) {
                        logError('Error writing to stream:', error);
                        startSpeechRecognition(ws);
                    }
                }
            } else if (data.type === 'stop') {
                logVerbose('🛑 Recording stopped');
                isRecording = false;
                if (recognizeStream && isStreamActive && !recognizeStream.destroyed) {
                    isStreamActive = false;
                    recognizeStream.end();
                }
                
                // Use complete transcript if we have final results, otherwise use last interim
                let finalTranscript = completeTranscript.trim();
                if (!finalTranscript && lastInterimTranscript.trim()) {
                    finalTranscript = lastInterimTranscript.trim();
                    logVerbose('📋 Using last interim as final transcript:', finalTranscript);
                } else if (finalTranscript) {
                    logVerbose('📋 Using complete final transcript:', finalTranscript);
                }
                
                // Process the transcript when button is released
                if (finalTranscript) {
                    logTerse('👤 User:', finalTranscript);
                    try {
                        await processUserInput(finalTranscript, ws);
                    } catch (error) {
                        logError('❌ Error processing transcript:', error);
                    }
                } else {
                    logVerbose('⚠️ Button released but no transcript to process');
                }
                
                // Reset for next recording
                completeTranscript = '';
                lastInterimTranscript = '';
            } else if (data.type === 'reset_conversation') {
                // Allow client to reset conversation
                await resetAgentSession();
                ws.send(JSON.stringify({
                    type: 'conversation_reset',
                    message: 'Conversation reset - starting fresh!'
                }));
            }
        } catch (error) {
            logError('Error processing message:', error);
        }
    });
    
    ws.on('close', async () => {
        activeConnections--;
        logTerse(`🔌 Client disconnected (ID: ${connectionId.slice(-8)}, Total: ${activeConnections})`);
        if (recognizeStream && !recognizeStream.destroyed) {
            isStreamActive = false;
            recognizeStream.end();
        }
        
        // Clean up agent session when client disconnects
        if (agentSessionId) {
            await endAgentSession();
        }
    });
    
    // Create agent session once per WebSocket connection
    async function createAgentSession() {
        if (agentSessionId) {
            logVerbose('✅ Session already exists:', agentSessionId);
            return agentSessionId; // Already have a session
        }
        
        try {
            logVerbose('🔄 Creating new agent session...');
            
            // Ensure we have a valid token
            const token = await ensureValidSalesforceToken();
            
            if (!token || !SALESFORCE_CONFIG.agentId) {
                throw new Error('Missing Salesforce credentials or agent ID');
            }
            
            const apiBaseURL = 'https://api.salesforce.com/einstein/ai-agent/v1';
            const sessionURL = `${apiBaseURL}/agents/${SALESFORCE_CONFIG.agentId}/sessions`;
            
            logVerbose('🔄 Calling:', sessionURL);
            
            const sessionResponse = await axios.post(sessionURL, {
                externalSessionKey: generateSessionId(),
                instanceConfig: {
                    endpoint: SALESFORCE_CONFIG.instanceUrl
                },
                streamingCapabilities: {
                    chunkTypes: ["Text"]
                },
                bypassUser: true
            }, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000
            });
            
            agentSessionId = sessionResponse.data.sessionId;
            messagesURL = sessionResponse.data._links.messages.href;
            sequenceId = 1; // Reset sequence for new session
            
            logVerbose('✅ Agent session created successfully:', agentSessionId);
            logVerbose('✅ Messages URL:', messagesURL);
            
            // Log greeting if present, but don't send it automatically
            if (sessionResponse.data.messages && sessionResponse.data.messages.length > 0) {
                const greeting = sessionResponse.data.messages[0].message;
                logVerbose('👋 Agent greeting available:', greeting);
            }
            
            return agentSessionId;
            
        } catch (error) {
            logError('❌ Failed to create agent session:', error.message);
            if (error.response) {
                logError('❌ Response status:', error.response.status);
                logError('❌ Response data:', error.response.data);
            }
            throw error;
        }
    }
    
    // Reset the agent session (for new conversation)
    async function resetAgentSession() {
        if (agentSessionId) {
            await endAgentSession();
        }
        agentSessionId = null;
        messagesURL = null;
        sequenceId = 1;
        await createAgentSession();
    }
    
    // End the agent session when connection closes
    async function endAgentSession() {
        if (!agentSessionId) return;
        
        try {
            const token = await ensureValidSalesforceToken();
            const apiBaseURL = 'https://api.salesforce.com/einstein/ai-agent/v1';
            const endURL = `${apiBaseURL}/sessions/${agentSessionId}`;
            
            await axios.delete(endURL, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
                timeout: 10000
            });
            
            logVerbose('✅ Agent session ended:', agentSessionId);
            
        } catch (error) {
            logError('❌ Failed to end agent session:', error.message);
        }
        
        agentSessionId = null;
        messagesURL = null;
        sequenceId = 1;
    }
    
    function startSpeechRecognition(ws) {
        // Clean up any existing stream
        if (recognizeStream && !recognizeStream.destroyed) {
            isStreamActive = false;
            recognizeStream.end();
        }
        
        const request = {
            config: {
                encoding: 'WEBM_OPUS',
                sampleRateHertz: 48000,
                languageCode: 'en-GB',
                enableAutomaticPunctuation: true,
                useEnhanced: true,
                model: 'latest_long',
            },
            interimResults: true,
            singleUtterance: false,
        };
        
        recognizeStream = speechClient
            .streamingRecognize(request)
            .on('error', (error) => {
                logError('Speech recognition error:', error);
                isStreamActive = false;
                // Restart stream on error
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        logVerbose('Restarting speech recognition stream...');
                        startSpeechRecognition(ws);
                    }
                }, 1000);
            })
            .on('data', async (data) => {
                const transcript = data.results[0]?.alternatives[0]?.transcript;
                const isFinal = data.results[0]?.isFinal;
                
                if (transcript && isRecording) {
                    logVerbose(`📝 Speech data: "${transcript}" (isFinal: ${isFinal})`);
                    
                    // Always update the last interim transcript
                    lastInterimTranscript = transcript;
                    
                    // Send interim results to client for visual feedback
                    ws.send(JSON.stringify({
                        type: 'transcript',
                        text: transcript,
                        isFinal: isFinal
                    }));
                    
                    // If we get a final result, add it to complete transcript
                    if (isFinal) {
                        if (completeTranscript) {
                            completeTranscript += ' ' + transcript;
                        } else {
                            completeTranscript = transcript;
                        }
                        logVerbose('✅ Added final to transcript:', transcript);
                        logVerbose('📋 Current complete transcript:', completeTranscript);
                        
                        // Reset interim since we got a final result
                        lastInterimTranscript = '';
                    } else {
                        logVerbose('⏳ Interim result (saved as fallback)');
                    }
                } else if (transcript) {
                    logVerbose('⚠️ Got transcript but not recording anymore');
                }
            });
            
        isStreamActive = true;
    }
    
    async function processUserInput(transcript, ws) {
        try {
            logVerbose('🔄 Processing user input:', transcript);
            
            // Ensure we have an agent session
            if (!agentSessionId) {
                logVerbose('🔄 No session found, creating new session...');
                await createAgentSession();
            }
            
            logVerbose('🎯 Using session:', agentSessionId);
            
            // Get response from Agentforce using persistent session
            const agentResponse = await callAgentforce(transcript);
            
            logVerbose('✅ Got agent response, converting to speech...');
            
            // Convert to speech
            const audioBuffer = await textToSpeech(agentResponse);
            
            logVerbose('✅ Sending response to client');
            
            // Send back to client
            ws.send(JSON.stringify({
                type: 'audio_response',
                audio: audioBuffer.toString('base64'),
                text: agentResponse
            }));
            
        } catch (error) {
            logError('❌ Error in processUserInput:', error);
            
            const fallbackResponse = "I'm sorry, I'm having trouble right now. Could you try again?";
            
            try {
                const audioBuffer = await textToSpeech(fallbackResponse);
                ws.send(JSON.stringify({
                    type: 'audio_response',
                    audio: audioBuffer.toString('base64'),
                    text: fallbackResponse
                }));
            } catch (ttsError) {
                logError('❌ TTS fallback also failed:', ttsError);
                // Send text-only response if TTS fails
                ws.send(JSON.stringify({
                    type: 'audio_response',
                    audio: '',
                    text: fallbackResponse
                }));
            }
        }
    }
    
    // Modified callAgentforce to use persistent session with better error handling
    async function callAgentforce(userMessage) {
        try {
            // Ensure we have a valid token
            const token = await ensureValidSalesforceToken();
            
            if (!token || !SALESFORCE_CONFIG.agentId) {
                return `I heard you say: "${userMessage}". The voice interface is working perfectly, but Salesforce integration needs to be configured.`;
            }
            
            // Ensure we have a session
            if (!agentSessionId) {
                await createAgentSession();
            }
            
            // Send message using existing session and incremented sequence
            const messagePayload = {
                message: {
                    sequenceId: sequenceId++, // Increment for conversation context
                    type: "Text",
                    text: userMessage
                },
                variables: []
            };
            
            const messageResponse = await axios.post(messagesURL, messagePayload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            });
            
            // Extract agent's response
            if (messageResponse.data.messages && messageResponse.data.messages.length > 0) {
                const informMessage = messageResponse.data.messages.find(msg => msg.type === 'Inform');
                if (informMessage && informMessage.message) {
                    logTerse('🤖 Agent:', informMessage.message);
                    return informMessage.message;
                }
            }
            
            return "I received your message but couldn't generate a response.";
            
        } catch (error) {
            logError('❌ Agentforce error:', error.response?.status, error.response?.statusText);
            
            if (error.response?.status === 401) {
                // Token expired, force refresh and retry once
                logTerse('🔄 Token expired, refreshing...');
                accessToken = null;
                tokenExpiresAt = null;
                
                try {
                    await ensureValidSalesforceToken();
                    return await callAgentforce(userMessage); // Retry once with new token
                } catch (retryError) {
                    logError('❌ Token refresh and retry failed:', retryError.message);
                }
            } else if (error.response?.status === 404 && agentSessionId) {
                // Session might have expired, create a new one
                logTerse('🔄 Session expired, creating new session...');
                await resetAgentSession();
                try {
                    return await callAgentforce(userMessage); // Retry with new session
                } catch (sessionRetryError) {
                    logError('❌ Session recreation and retry failed:', sessionRetryError.message);
                }
            }
            
            // If all retries fail
            throw error;
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logTerse(`🎤 Voice Agent Service running on port ${PORT}`);
    logTerse('🔊 Log Level:', LOG_LEVEL);
    if (LOG_LEVEL === 'verbose') {
        logTerse('Make sure Google Cloud credentials are configured!');
    }
    logTerse('🌐 Ready for voice interactions');
});
// Just confirming this is new.