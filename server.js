//require('dotenv').config();

//const express = require('express');
//const WebSocket = require('ws');
//const speech = require('@google-cloud/speech');
//const textToSpeechClient = require('@google-cloud/text-to-speech');
//const axios = require('axios');
//const jsforce = require('jsforce');

// Initialize Google Cloud clients
//const speechClient = new speech.SpeechClient();
//const ttsClient = new textToSpeechClient.TextToSpeechClient();

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

// Global variables for Salesforce connection
let salesforceConnection = null;
let accessToken = null;

const app = express();
const server = require('http').createServer(app);

// Serve static files for the web interface
app.use(express.static('public'));

// Generate unique session IDs
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Initialize Salesforce connection using Client Credentials flow
async function initializeSalesforce() {
    try {
        logTerse('🔄 Initializing Salesforce connection...');
        
        if (!SALESFORCE_CONFIG.clientId || !SALESFORCE_CONFIG.clientSecret) {
            logError('❌ Missing Salesforce credentials in .env file');
            return false;
        }
        
        logVerbose('Using Client Credentials Flow for Agent API...');
        
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
        });
        
        accessToken = tokenResponse.data.access_token;
        logTerse('✅ Salesforce authentication successful!');
        logVerbose('Instance URL:', SALESFORCE_CONFIG.instanceUrl);
        logVerbose('Agent ID:', SALESFORCE_CONFIG.agentId);
        
        return true;
        
    } catch (error) {
        logError('❌ Salesforce connection failed:', error.message);
        logTerse('Running in demo mode. Check your .env file configuration.');
        return false;
    }
}

// Convert text to speech (British English)
async function textToSpeech(text) {
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
}

// Initialize Salesforce on startup
initializeSalesforce();

// WebSocket server for real-time voice communication
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    logTerse('🔗 New client connected');
    
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
        logTerse('🔌 Client disconnected');
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
            
            if (!accessToken || !SALESFORCE_CONFIG.agentId) {
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
                    'Authorization': `Bearer ${accessToken}`,
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
            const apiBaseURL = 'https://api.salesforce.com/einstein/ai-agent/v1';
            const endURL = `${apiBaseURL}/sessions/${agentSessionId}`;
            
            await axios.delete(endURL, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
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
            const audioBuffer = await textToSpeech(fallbackResponse);
            
            ws.send(JSON.stringify({
                type: 'audio_response',
                audio: audioBuffer.toString('base64'),
                text: fallbackResponse
            }));
        }
    }
    
    // Modified callAgentforce to use persistent session
    async function callAgentforce(userMessage) {
        if (!accessToken || !SALESFORCE_CONFIG.agentId) {
            return `I heard you say: "${userMessage}". The voice interface is working perfectly, but Salesforce integration needs to be configured.`;
        }
        
        try {
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
                    'Authorization': `Bearer ${accessToken}`,
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
                // Try to reconnect
                const reconnected = await initializeSalesforce();
                if (reconnected) {
                    return await callAgentforce(userMessage);
                }
            } else if (error.response?.status === 404 && agentSessionId) {
                // Session might have expired, create a new one
                logVerbose('🔄 Session expired, creating new session...');
                await resetAgentSession();
                return await callAgentforce(userMessage);
            }
            
            return "I'm having trouble connecting to the agent right now. Please try again.";
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
    logTerse('🌐 Open http://localhost:3000 to use the voice interface');
});
