import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, StartSensitivity, EndSensitivity, ActivityHandling } from '@google/genai';
import { AudioStreamer } from '../utils/audio';
import { generateContentWithRetry } from '../utils/gemini';
import { LoreProfile } from '../types';
import { Mic, MicOff, Upload, Check, Loader2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ForgeProps {
  onNavigate: () => void;
}

// System instruction for the Gemini Live API to act as an energetic Interview Agent
const SYSTEM_INSTRUCTION = `You are the Interview Agent for "Dreamie," an app designed to help users with ADHD overcome executive dysfunction by turning mundane chores into epic, immersive quests based on their personal daydreams.
Your interface is voice-to-voice. Speak naturally, warmly, and with high energy. Be encouraging and non-judgmental. Do not sound like a robotic assistant; sound like a passionate dungeon master or creative director brainstorming with a friend.

CRITICAL RULES:
1. LANGUAGE: You MUST ONLY speak and understand English. If the user's speech sounds like another language, assume it is a misinterpretation of English or a fantasy name. NEVER switch to German or any other language.
2. INTERRUPTION: The user can interrupt you at any time. If the user barges in or starts speaking while you are talking, you MUST immediately stop your current thought, yield the floor, and listen to what they are saying. Be highly responsive to interruptions.

Your objective is to discover the user's favorite "maladaptive daydream" or fantasy scenario so we can build a "Lore Profile" for them. 
Follow these steps conversationally:
1. Greet the user warmly and ask what kind of world they usually escape to or daydream about (e.g., Cyberpunk dystopia, High Fantasy kingdom, Deep Space exploration).
2. Ask probing, exciting questions to flesh out the details: 
   - What is their specific role or class (e.g., Rogue hacker, Dragon slayer, Starship captain)?
   - Who or what are the primary enemies/antagonists?
   - What is the general visual aesthetic of this world?
3. Validate their ideas enthusiastically. Keep the back-and-forth going until you have a solid grasp of the Genre, Character Role, Enemies, and Aesthetic.
4. Once you have enough detail, summarize the epic lore back to them and tell them they can click the "Finish Interview" button on their screen to proceed.`;

/**
 * Forge Component
 * 
 * The profile creation screen where users forge their "Lore Profile".
 * The process involves several steps:
 * 1. Upload: User uploads a selfie to be used as a structural reference for their avatar.
 * 2. Interview: User talks to a Gemini Live voice agent to describe their fantasy world.
 * 3. Extracting: The app uses Gemini to extract structured JSON lore from the interview transcript.
 * 4. Confirm: User reviews the extracted lore.
 * 5. Saving: The app generates a stylized avatar using Gemini Flash Image and saves the profile to the backend.
 */
type ChatMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  isFinished?: boolean;
};

/**
 * Compresses a base64 image string to ensure it fits within Firestore limits.
 */
const compressImage = async (base64Str: string, maxWidth = 800, quality = 0.7): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } else {
        resolve(base64Str);
      }
    };
    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
};

export default function Forge({ onNavigate }: ForgeProps) {
  // State to manage the current step in the profile creation flow
  const [step, setStep] = useState<'upload' | 'interview' | 'extracting' | 'confirm' | 'saving'>('upload');
  // State to store the base64 encoded selfie image
  const [selfie, setSelfie] = useState<string | null>(null);
  // State to track if the voice recording/live session is active
  const [isRecording, setIsRecording] = useState(false);
  // State to store the extracted lore data
  const [loreData, setLoreData] = useState<LoreProfile | null>(null);
  // State to accumulate the conversation messages during the live session
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // State to track if the avatar generation is in progress
  const [isGeneratingAvatar, setIsGeneratingAvatar] = useState(false);
  // State to store the generated avatar URL
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // State to store error messages
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Auto-hide error message
  useEffect(() => {
    if (errorMsg) {
      const timer = setTimeout(() => setErrorMsg(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [errorMsg]);

  // Refs for managing audio streaming and the Gemini Live session
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const sessionPromiseRef = useRef<any>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the transcript as new text streams in
  useEffect(() => {
    if (step === 'interview' && transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, step]);

  /**
   * Initialize the GoogleGenAI instance on mount and clean up resources on unmount.
   */
  useEffect(() => {
    aiRef.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return () => {
      if (audioStreamerRef.current) {
        audioStreamerRef.current.close();
      }
      if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then((session: any) => session.close());
      }
    };
  }, []);

  /**
   * Handle user uploading a selfie.
   * Resizes the image to a maximum of 1024x1024 to optimize for the image generation model.
   * Converts the image to a base64 string and moves to the 'interview' step.
   */
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 1024;
          const MAX_HEIGHT = 1024;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            setSelfie(canvas.toDataURL('image/jpeg', 0.8));
          } else {
            setSelfie(reader.result as string);
          }
          setStep('interview');
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  /**
   * Toggle the voice recording and Gemini Live session.
   * Starts the audio streamer and connects to the Gemini Live API.
   * Handles incoming audio and text from the model.
   */
  const toggleRecording = async () => {
    if (isRecording) {
      // Stop recording
      if (audioStreamerRef.current) {
        audioStreamerRef.current.stopRecording();
      }
      if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then((session: any) => {
          session.sendRealtimeInput({ audioStreamEnd: true });
        });
      }
      setIsRecording(false);
    } else {
      // Start recording
      if (!audioStreamerRef.current) {
        audioStreamerRef.current = new AudioStreamer();
      }
      
      if (!sessionPromiseRef.current && aiRef.current) {
        // Initialize Live Session
        sessionPromiseRef.current = aiRef.current.live.connect({
          model: "gemini-2.5-flash-native-audio-preview-09-2025",
          callbacks: {
            onopen: () => {
              console.log("Live session opened");
            },
            onmessage: async (message: LiveServerMessage) => {
              // Handle audio output from the model
              const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              if (base64Audio && audioStreamerRef.current) {
                audioStreamerRef.current.playAudio(base64Audio);
              }
              
              // Handle interruption (e.g., user starts speaking while model is speaking)
              if (message.serverContent?.interrupted && audioStreamerRef.current) {
                audioStreamerRef.current.stopPlayback();
              }

              // Accumulate actual audio transcription (interleaved with audio)
              let outText = message.serverContent?.outputTranscription?.text;
              if (outText !== undefined) {
                outText = outText.replace(/<noise>/gi, '').replace(/\[noise\]/gi, '');
              }
              const outFinished = message.serverContent?.outputTranscription?.finished;
              
              if (outText !== undefined || outFinished) {
                setMessages(prev => {
                  const newMsgs = prev.map(msg => ({ ...msg }));
                  // Mark any open user messages as finished since agent is speaking
                  for (let i = newMsgs.length - 1; i >= 0; i--) {
                    if (newMsgs[i].role === 'user' && !newMsgs[i].isFinished) {
                      newMsgs[i].isFinished = true;
                    }
                  }

                  let lastIdx = -1;
                  for (let i = newMsgs.length - 1; i >= 0; i--) {
                    if (newMsgs[i].role === 'agent' && !newMsgs[i].isFinished) {
                      lastIdx = i;
                      break;
                    }
                  }
                  if (lastIdx !== -1) {
                    if (outText !== undefined) newMsgs[lastIdx].text += outText;
                    if (outFinished) newMsgs[lastIdx].isFinished = true;
                  } else if (outText !== undefined && outText.trim() !== '') {
                    newMsgs.push({ 
                      id: Date.now().toString() + Math.random(), 
                      role: 'agent', 
                      text: outText, 
                      isFinished: outFinished || false 
                    });
                  }
                  return newMsgs;
                });
              }

              // Accumulate user's input transcription
              let inText = message.serverContent?.inputTranscription?.text;
              if (inText !== undefined) {
                inText = inText.replace(/<noise>/gi, '').replace(/\[noise\]/gi, '');
              }
              const inFinished = message.serverContent?.inputTranscription?.finished;
              
              if (inText !== undefined || inFinished) {
                setMessages(prev => {
                  const newMsgs = prev.map(msg => ({ ...msg }));
                  // Mark any open agent messages as finished since user is speaking
                  for (let i = newMsgs.length - 1; i >= 0; i--) {
                    if (newMsgs[i].role === 'agent' && !newMsgs[i].isFinished) {
                      newMsgs[i].isFinished = true;
                    }
                  }

                  let lastIdx = -1;
                  for (let i = newMsgs.length - 1; i >= 0; i--) {
                    if (newMsgs[i].role === 'user' && !newMsgs[i].isFinished) {
                      lastIdx = i;
                      break;
                    }
                  }
                  if (lastIdx !== -1) {
                    if (inText !== undefined) newMsgs[lastIdx].text += inText;
                    if (inFinished) newMsgs[lastIdx].isFinished = true;
                  } else if (inText !== undefined && inText.trim() !== '') {
                    newMsgs.push({ 
                      id: Date.now().toString() + Math.random(), 
                      role: 'user', 
                      text: inText, 
                      isFinished: inFinished || false 
                    });
                  }
                  return newMsgs;
                });
              }

              // Mark agent turn as complete
              if (message.serverContent?.turnComplete) {
                setMessages(prev => {
                  const newMsgs = prev.map(msg => ({ ...msg }));
                  for (let i = newMsgs.length - 1; i >= 0; i--) {
                    if (newMsgs[i].role === 'agent' && !newMsgs[i].isFinished) {
                      newMsgs[i].isFinished = true;
                      break;
                    }
                  }
                  return newMsgs;
                });
              }
            },
            onerror: (e) => {
              console.error("Live session error", e);
              setErrorMsg("Connection error with the Live Agent. Please try again.");
              setIsRecording(false);
            },
            onclose: () => console.log("Live session closed"),
          },
          config: {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {}, // Request interleaved text transcription
            inputAudioTranscription: {}, // Request user input transcription
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
            },
            systemInstruction: SYSTEM_INSTRUCTION,
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
                prefixPaddingMs: 200,
                silenceDurationMs: 500,
              },
              activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            },
          },
        });
      }

      // Start capturing audio from the microphone and sending it to the live session
      await audioStreamerRef.current.startRecording((base64Data) => {
        if (sessionPromiseRef.current) {
          sessionPromiseRef.current.then((session: any) => {
            session.sendRealtimeInput({
              audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
            });
          });
        }
      });
      setIsRecording(true);
    }
  };

  /**
   * Finish the interview phase.
   * Stops recording, closes the live session, and uses Gemini to extract
   * structured JSON lore from the accumulated transcript AND generate an avatar image
   * in a single interleaved API call.
   */
  const finishInterview = async () => {
    if (isRecording) {
      await toggleRecording();
    }
    
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then((session: any) => session.close());
      sessionPromiseRef.current = null;
    }
    
    setStep('extracting');
    
    try {
      if (!aiRef.current || !selfie) return;
      
      const base64Image = selfie.split(',')[1];
      const mimeType = selfie.split(';')[0].split(':')[1];

      // Construct a prompt that asks for BOTH JSON extraction and an image generation
      const transcriptString = messages
        .filter(m => m.text.trim() !== '')
        .map(m => `${m.role === 'user' ? 'User' : 'Oracle'}: ${m.text}`)
        .join('\n');
        
      // 1. Extract JSON using a text model
      const jsonPrompt = `Here is a transcript of an interview with a user about their fantasy daydream:\n\n${transcriptString || "The user wants a generic fantasy adventure."}\n\nExtract the lore details into a structured JSON format with the following keys: genre, character_role, primary_enemies, visual_aesthetic, core_motivation.`;
      
      let parsed = {
        genre: "Unknown Mythos",
        character_role: "Wandering Hero",
        primary_enemies: "Shadows of Doubt",
        visual_aesthetic: "Ethereal Mist",
        core_motivation: "To find one's true purpose",
      };

      try {
        const jsonResponse = await generateContentWithRetry(aiRef.current, {
          model: 'gemini-3-flash-preview',
          contents: jsonPrompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                genre: { type: Type.STRING },
                character_role: { type: Type.STRING },
                primary_enemies: { type: Type.STRING },
                visual_aesthetic: { type: Type.STRING },
                core_motivation: { type: Type.STRING }
              },
              required: ["genre", "character_role", "primary_enemies", "visual_aesthetic", "core_motivation"]
            }
          }
        });

        parsed = JSON.parse(jsonResponse.text || "{}");
      } catch (e) {
        console.warn("Failed to extract JSON from text output, using fallback", e);
      }
      
      setLoreData(parsed as any);
      
      // 2. Generate Image using the extracted lore
      let generatedUrl = null;
      try {
        const imagePrompt = `Generate a stylized realistic high fidelity art style, 8k resolution, cinematic lighting, masterpiece portrait of the character described as: Role: ${(parsed as any).character_role}, Genre: ${(parsed as any).genre}, Aesthetic: ${(parsed as any).visual_aesthetic}. They are standing proudly against the backdrop of their enemies: ${(parsed as any).primary_enemies}. Use the provided image as a structural reference for the character's face.`;

        const imageResponse = await generateContentWithRetry(aiRef.current, {
          model: 'gemini-3.1-flash-image-preview',
          contents: {
            parts: [
              { inlineData: { data: base64Image, mimeType } }, // Provide the selfie as structural reference
              { text: imagePrompt }
            ]
          },
          config: {
            imageConfig: {
              aspectRatio: "1:1",
              imageSize: "512px"
            }
          }
        });

        // Iterate through the parts to find the image
        for (const part of imageResponse.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) {
            const mime = part.inlineData.mimeType || 'image/png';
            generatedUrl = `data:${mime};base64,${part.inlineData.data}`;
          }
        }
      } catch (e) {
        console.warn("Failed to generate avatar image, using selfie as fallback", e);
      }

      setLoreData(parsed as any);
      if (generatedUrl) {
        setAvatarUrl(generatedUrl);
      } else {
        setAvatarUrl(selfie);
      }
      setStep('confirm');
    } catch (e) {
      console.error("Fatal error in finishInterview", e);
      // Fallback data in case everything fails
      setLoreData({
        genre: "Unknown Mythos",
        character_role: "Wandering Hero",
        primary_enemies: "Shadows of Doubt",
        visual_aesthetic: "Ethereal Mist",
        core_motivation: "To find one's true purpose",
        avatar_url: selfie || ""
      } as any);
      setStep('confirm');
    }
  };

  /**
   * Save the finalized lore profile to the backend.
   */
  const saveLore = async () => {
    if (!loreData) return;
    setStep('saving');
    
    try {
      const { auth, db } = await import('../firebase');
      const { collection, addDoc, serverTimestamp } = await import('firebase/firestore');
      
      const user = auth.currentUser;
      if (!user) {
        throw new Error("User not authenticated");
      }

      let finalAvatar = avatarUrl || selfie;
      if (finalAvatar) {
        finalAvatar = await compressImage(finalAvatar, 800, 0.6);
      }

      // Add a timeout to the Firestore operation in case the database doesn't exist
      // or the client is offline, preventing an infinite hang.
      const savePromise = addDoc(collection(db, 'users', user.uid, 'profiles'), {
        ...loreData,
        uid: user.uid,
        avatar_url: finalAvatar,
        createdAt: serverTimestamp()
      });

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Database connection timed out. Please ensure you have created a Firestore Database in your Firebase Console.")), 10000)
      );

      await Promise.race([savePromise, timeoutPromise]);
      
      onNavigate();
    } catch (e: any) {
      console.error("Failed to save lore", e);
      setErrorMsg(e.message || "Failed to save profile. Please try again.");
      setStep('confirm');
    }
  };

  return (
    <div className="min-h-screen flex flex-col p-6 max-w-md mx-auto relative">
      {/* Error Toast */}
      <AnimatePresence>
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="absolute top-4 left-4 right-4 z-50 bg-red-500/90 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 backdrop-blur-sm"
          >
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p className="text-sm font-medium">{errorMsg}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {step !== 'interview' && (
        <header className="mb-8 pt-8 text-center shrink-0">
          <h1 className="text-3xl font-bold tracking-tight text-emerald-400">The Forge</h1>
          <p className="text-zinc-400 mt-2">Create your epic legend</p>
        </header>
      )}

      <AnimatePresence mode="wait">
        {/* Step 1: Upload Selfie */}
        {step === 'upload' && (
          <motion.div 
            key="upload"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col items-center justify-center"
          >
            <div className="w-full max-w-xs aspect-[3/4] bg-zinc-900 border-2 border-dashed border-zinc-700 rounded-3xl flex flex-col items-center justify-center relative overflow-hidden group hover:border-emerald-500 transition-colors">
              <input 
                type="file" 
                accept="image/*" 
                onChange={handleImageUpload}
                className="absolute inset-0 opacity-0 cursor-pointer z-10"
              />
              <div className="flex flex-col items-center gap-4 text-zinc-500 group-hover:text-emerald-400 transition-colors">
                <Upload className="w-12 h-12" />
                <span className="font-medium text-center px-6">Upload a selfie to forge your Avatar</span>
              </div>
            </div>
          </motion.div>
        )}

        {/* Step 2: Voice Interview */}
        {step === 'interview' && (
          <motion.div 
            key="interview"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col items-center justify-start gap-4 w-full pt-4 h-full"
          >
            <div className="text-center space-y-4 w-full flex-1 flex flex-col min-h-0">
              <div className="shrink-0 flex justify-between items-start w-full">
                <div className="text-left flex-1 pr-4">
                  <h2 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#9b8afb] to-[#d4c8ff]">
                    Getting to Know You
                  </h2>
                  <p className="text-zinc-400 text-sm mt-1">
                    Describe your daydreams
                  </p>
                </div>
                <button 
                  onClick={toggleRecording}
                  className={`w-14 h-14 shrink-0 rounded-full flex items-center justify-center transition-all ${
                    isRecording 
                      ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20' 
                      : 'bg-[#5442f5] text-white hover:bg-[#4335c4] shadow-[0_0_20px_rgba(84,66,245,0.3)]'
                  }`}
                >
                  {isRecording ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                </button>
              </div>
              
              {/* Interleaved Output: Chat Interface */}
              <div className="w-full flex-1 bg-[#0f1115]/80 border border-zinc-800/50 rounded-xl p-4 overflow-y-auto flex flex-col gap-4 shadow-inner relative custom-scrollbar min-h-0">
                {messages.filter(msg => msg.text.trim() !== '' && msg.role === 'agent').length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-zinc-500 font-mono text-sm text-center">
                    {isRecording ? "Listening to your thoughts..." : "Click the microphone to begin..."}
                  </div>
                ) : (
                  messages.filter(msg => msg.text.trim() !== '' && msg.role === 'agent').map((msg) => (
                    <div key={msg.id} className="flex flex-col items-start">
                      <div className="max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed text-left bg-[#5442f5] text-white rounded-bl-sm">
                        {msg.text}
                      </div>
                      <span className="text-[10px] text-zinc-500 font-medium mt-1 uppercase tracking-wider px-1">
                        AI Host
                      </span>
                    </div>
                  ))
                )}
                <div ref={transcriptEndRef} />
              </div>
            </div>

            {messages.length > 0 && (
              <div className="w-full shrink-0 mt-2 pb-2">
                <button
                  onClick={finishInterview}
                  className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium py-4 px-8 rounded-xl transition-colors border border-zinc-700"
                >
                  Finish Interview
                </button>
              </div>
            )}
          </motion.div>
        )}

        {/* Step 3: Extracting Lore */}
        {step === 'extracting' && (
          <motion.div 
            key="extracting"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col items-center justify-center text-center gap-6"
          >
            <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
            <div>
              <h2 className="text-2xl font-bold text-zinc-100 mb-2">Forging Legend</h2>
              <p className="text-zinc-400">Extracting the essence of your fantasy...</p>
            </div>
            <button 
              onClick={() => {
                setLoreData({
                    genre: "Unknown Mythos",
                    character_role: "Wandering Hero",
                    primary_enemies: "Shadows of Doubt",
                    visual_aesthetic: "Ethereal Mist",
                    core_motivation: "To find one's true purpose",
                    avatar_url: selfie || ""
                });
                setStep('confirm');
              }}
              className="mt-8 text-sm text-zinc-500 hover:text-zinc-300 underline"
            >
              Taking too long? Skip extraction.
            </button>
          </motion.div>
        )}

        {/* Step 4: Confirm Lore */}
        {step === 'confirm' && loreData && (
          <motion.div 
            key="confirm"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col"
          >
            <div className="bg-zinc-900 rounded-3xl p-6 border border-zinc-800 shadow-xl mb-8">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <Check className="w-6 h-6 text-emerald-400" />
                Lore Forged
              </h2>
              <p className="text-sm text-zinc-400 mb-6">Review and edit your lore before accepting your destiny.</p>
              
              <div className="space-y-4">
                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Role</span>
                  <input 
                    value={loreData.character_role}
                    onChange={(e) => setLoreData({ ...loreData, character_role: e.target.value })}
                    className="w-full bg-transparent border-b border-zinc-700 text-emerald-400 font-medium text-lg focus:outline-none focus:border-emerald-400 pb-1 transition-colors"
                  />
                </div>
                <div className="h-px bg-zinc-800" />
                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Genre</span>
                  <input 
                    value={loreData.genre}
                    onChange={(e) => setLoreData({ ...loreData, genre: e.target.value })}
                    className="w-full bg-transparent border-b border-zinc-700 text-zinc-300 focus:outline-none focus:border-zinc-500 pb-1 transition-colors"
                  />
                </div>
                <div className="h-px bg-zinc-800" />
                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Enemies</span>
                  <input 
                    value={loreData.primary_enemies}
                    onChange={(e) => setLoreData({ ...loreData, primary_enemies: e.target.value })}
                    className="w-full bg-transparent border-b border-zinc-700 text-zinc-300 focus:outline-none focus:border-zinc-500 pb-1 transition-colors"
                  />
                </div>
                <div className="h-px bg-zinc-800" />
                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Aesthetic</span>
                  <input 
                    value={loreData.visual_aesthetic}
                    onChange={(e) => setLoreData({ ...loreData, visual_aesthetic: e.target.value })}
                    className="w-full bg-transparent border-b border-zinc-700 text-zinc-300 focus:outline-none focus:border-zinc-500 pb-1 transition-colors"
                  />
                </div>
              </div>
            </div>

            <button 
              onClick={saveLore}
              className="mt-auto w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all active:scale-95"
            >
              Accept Destiny
            </button>
          </motion.div>
        )}

        {/* Step 5: Saving and Generating Avatar */}
        {step === 'saving' && (
          <motion.div 
            key="saving"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col items-center justify-center text-center gap-6"
          >
            <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
            <div>
              <h2 className="text-2xl font-bold text-zinc-100 mb-2">Forging Avatar</h2>
              <p className="text-zinc-400">Summoning your digital form from the ether...</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
