import React, { useRef, useState, useEffect } from 'react';
import { LoreProfile } from '../types';
import { Camera, Scan, Sparkles, ArrowLeft, Loader2, Mic, MicOff, User, Bot } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { AudioStreamer } from '../utils/audio';
import { generateContentWithRetry } from '../utils/gemini';

interface ScoutingProps {
  profile: LoreProfile;
  onBack: () => void;
  onEngage: (questId: string) => void;
}

type ChatMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  isFinished?: boolean;
};

// System instruction for the Gemini Live API to act as a tactical scout
const SYSTEM_INSTRUCTION = `You are the "Scout" for Project Dreamie. 
Your goal is to survey the user's physical environment via their camera and map it to their thematic lore.
LORE PROFILE:
- Role: {{ROLE}}
- Genre: {{GENRE}}
- Enemies: {{ENEMIES}}
- Aesthetic: {{AESTHETIC}}

Your behavior:
1. Act like a tactical scout or companion appropriate to the genre (e.g., an AI drone for Cyberpunk/Sci-Fi, a wisp for Fantasy).
2. Ask the user to show their environment and ask what is it they need to do.
3. Comment on what you see in the video feed. If you see laundry, call it out as a terrain feature or enemy type based on the lore.
4. Be brief, punchy, and interactive.
5. DO NOT generate the final quest JSON yourself. Just gather intelligence and build rapport.`;

/**
 * Scouting Component
 * 
 * The planning phase where the user surveys their real-world environment.
 * Features:
 * - Camera feed display.
 * - Gemini Live session for voice interaction and real-time video frame analysis.
 * - Complex multi-agent prompt chain to generate a structured "Quest Plan" based on the environment and lore.
 *   - Mapping Agent: Maps real-world chores to fantasy actions.
 *   - Narrative Agent: Creates a cohesive story arc.
 *   - Planner Agent: Groups actions into scenes and generates image prompts.
 *   - Supervision Agent: Generates state machine logic for MediaPipe object detection during the execution phase.
 */
export default function Scouting({ profile, onBack, onEngage }: ScoutingProps) {
  // Video element reference for capturing camera frames
  const videoRef = useRef<HTMLVideoElement>(null);
  // State to hold the active media stream
  const [stream, setStream] = useState<MediaStream | null>(null);
  // State to track if the Gemini Live session is active
  const [isLive, setIsLive] = useState(false);
  // State to track if the complex quest generation process is running
  const [isGenerating, setIsGenerating] = useState(false);
  // State to store the final generated quest plan and its ID
  const [scanResult, setScanResult] = useState<any>(null);
  // State for error handling
  const [error, setError] = useState<string | null>(null);
  // State to accumulate the conversation transcript during the live session
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // State to toggle the raw JSON view of the generated quest
  const [showDetails, setShowDetails] = useState(false);

  // Refs for managing audio streaming, the live session, and the AI client
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const sessionPromiseRef = useRef<any>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);
  // Ref to manage the interval for sending video frames to the live session
  const videoIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Initialize camera and AI client on mount. Clean up on unmount.
   */
  useEffect(() => {
    startCamera();
    aiRef.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    return () => {
      stopCamera();
      stopLiveSession();
    };
  }, []);

  /**
   * Request access to the user's environment-facing camera and attach it to the video element.
   */
  const startCamera = async () => {
    try {
      setError(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Camera access denied. Please check your browser permissions.");
    }
  };

  /**
   * Stop all tracks on the active media stream.
   */
  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };

  /**
   * Capture the current frame from the video element and resize it.
   * Resizing to a max of 640px reduces latency for live streaming and token usage.
   * 
   * @param quality The JPEG compression quality (0 to 1).
   * @returns A base64 encoded JPEG data URL, or null if capture fails.
   */
  const captureFrame = (quality = 0.5): string | null => {
    if (!videoRef.current) return null;
    const canvas = document.createElement('canvas');
    
    // Resize to max 640px for live streaming to reduce latency
    const MAX_DIMENSION = 640;
    let width = videoRef.current.videoWidth;
    let height = videoRef.current.videoHeight;
    
    if (width > height) {
      if (width > MAX_DIMENSION) {
        height *= MAX_DIMENSION / width;
        width = MAX_DIMENSION;
      }
    } else {
      if (height > MAX_DIMENSION) {
        width *= MAX_DIMENSION / height;
        height = MAX_DIMENSION;
      }
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    
    ctx.drawImage(videoRef.current, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
  };

  /**
   * Start the Gemini Live session for interactive scouting.
   * Connects to the API, sets up audio streaming, and starts an interval
   * to send video frames at 1 FPS.
   */
  const startLiveSession = async () => {
    if (!aiRef.current) return;
    setIsLive(true);
    setError(null);

    try {
      audioStreamerRef.current = new AudioStreamer();

      // Inject the user's specific lore into the system instruction
      const filledInstruction = SYSTEM_INSTRUCTION
        .replace('{{ROLE}}', profile.character_role)
        .replace('{{GENRE}}', profile.genre)
        .replace('{{ENEMIES}}', profile.primary_enemies)
        .replace('{{AESTHETIC}}', profile.visual_aesthetic);

      sessionPromiseRef.current = aiRef.current.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        callbacks: {
          onopen: () => {
            console.log("Scout session opened");
            // Start video streaming loop (1 FPS is sufficient for scouting)
            videoIntervalRef.current = setInterval(() => {
              const frame = captureFrame(0.5);
              if (frame && sessionPromiseRef.current) {
                const base64Data = frame.split(',')[1];
                sessionPromiseRef.current.then((session: any) => {
                  session.sendRealtimeInput({
                    media: { data: base64Data, mimeType: 'image/jpeg' }
                  });
                });
              }
            }, 1000); 
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle incoming audio from the model
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioStreamerRef.current) {
              audioStreamerRef.current.playAudio(base64Audio);
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
          onerror: (e) => console.error("Live session error", e),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {}, // Request interleaved text transcription
          inputAudioTranscription: {}, // Request user input transcription
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Fenrir" } }, // Deeper, more tactical voice
          },
          systemInstruction: filledInstruction,
        },
      });

      // Start capturing audio from the microphone and sending it to the live session
      await audioStreamerRef.current.startRecording((base64Data) => {
        if (sessionPromiseRef.current) {
          sessionPromiseRef.current.then((session: any) => {
            session.sendRealtimeInput({
              media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
            });
          });
        }
      });

    } catch (err) {
      console.error("Failed to start live session", err);
      setError("Failed to connect to Scout. Please try again.");
      setIsLive(false);
    }
  };

  /**
   * Stop the live session, clear intervals, and close audio/session resources.
   */
  const stopLiveSession = () => {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (audioStreamerRef.current) {
      audioStreamerRef.current.stopRecording();
      audioStreamerRef.current.close();
      audioStreamerRef.current = null;
    }
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then((session: any) => session.close());
      sessionPromiseRef.current = null;
    }
    setIsLive(false);
  };

  /**
   * Core logic for generating the complex Quest Plan.
   * This involves a multi-step prompt chain using Gemini 3.1 Pro.
   * 
   * @param finalFrame A high-quality capture of the environment to base the quest on.
   * @returns The complete structured quest plan.
   */
  const generateQuestClientSide = async (finalFrame: string) => {
    if (!aiRef.current) throw new Error("AI client not initialized");

    const base64Image = finalFrame.split(',')[1];
    const mimeType = finalFrame.split(';')[0].split(':')[1];

    const transcriptString = messages
      .filter(m => m.text.trim() !== '')
      .map(m => `${m.role === 'user' ? 'User' : 'Scout'}: ${m.text}`)
      .join('\n');

    console.log("Generating quest with transcript length:", transcriptString.length);
    
    // Truncate transcript if it's too long (approx 20k chars is plenty for context)
    const safeTranscript = transcriptString.length > 20000 
      ? transcriptString.slice(-20000) 
      : transcriptString;

    // Sanitize profile to remove potentially large base64 avatar_url to save tokens
    const safeProfile = { ...profile };
    if (safeProfile.avatar_url && safeProfile.avatar_url.startsWith('data:')) {
      safeProfile.avatar_url = "[Image Data Omitted]";
    }

    // --- 1. Mapping Agent ---
    // Analyzes the image and transcript to map real-world chores to fantasy actions.
    const mappingPrompt = `
      You are the Mapping Agent for "Dreamie." Your job is to bridge physical reality with imaginative fiction.
      LORE PROFILE: ${JSON.stringify(safeProfile)}
      VISUAL INPUT: An image of the user's environment.
      TRANSCRIPT CONTEXT: ${safeTranscript || "No verbal context provided."}
      
      Task: Analyze the visual input AND the transcript. Identify the user's goal (e.g., cleaning the room, doing homework) and break it down into a list of to-do real-life actions. Then, map the accomplishment of each user action to various protagonist actions in the fictional world based strictly on the LORE PROFILE genre.
      Rules:
      - The fictional actions should have some semblance and close representation of the real world action, but MUST match the LORE PROFILE genre (e.g., Cyberpunk, Sci-Fi, Fantasy).
      - Example (Fantasy): Tidy blanket -> cast spell to manipulate ocean waves.
      - Example (Cyberpunk): Tidy blanket -> deploy nanobots to restructure the smart-fabric.
      - Identify the objects involved in the real-world action (e.g., "blanket", "water bottle", "mop").
      - IMPORTANT: Return EXACTLY 3 to 5 actions in the array.
    `;

    const mappingResponse = await generateContentWithRetry(aiRef.current, {
      model: "gemini-3.1-pro-preview",
      contents: {
        parts: [
          { inlineData: { data: base64Image, mimeType } },
          { text: mappingPrompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              real_world_action: { type: Type.STRING },
              fantasy_action: { type: Type.STRING },
              objects_involved: { 
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            },
            required: ["real_world_action", "fantasy_action", "objects_involved"]
          }
        }
      }
    });

    let mappings = [];
    try {
       mappings = JSON.parse(mappingResponse.text || "[]");
    } catch (e) {
       console.warn("JSON parse failed, using regex fallback");
       const match = mappingResponse.text?.match(/\[.*\]/s);
       if (match) mappings = JSON.parse(match[0]);
    }
    
    // Fallback if mapping fails completely
    if (!mappings || mappings.length === 0) {
        mappings = [{
            real_world_action: "Clear the floor",
            fantasy_action: `Overcome the ${safeProfile.primary_enemies || "enemies"} blocking the path`,
            objects_involved: ["floor", "clutter"]
        }];
    }

    // --- 2. Narrative Agent ---
    // Takes the mapped actions and weaves them into a cohesive story arc.
    const narrativePrompt = `
      You are the Master Storyteller for "Dreamie."
      LORE PROFILE: ${JSON.stringify(safeProfile)}
      MAPPED ACTIONS: ${JSON.stringify(mappings)}
      
      Task: Write a cohesive, adrenaline-pumping story matching the LORE PROFILE genre, linking all these mapped actions in a coherent manner to build up a story which makes chronological and narrative sense.
      Rules:
      - Multiple actions undertaken by the user should not be represented as disjointed unrelated events.
      - HIGH OCTANE: Relentless pacing.
      - EMOTIONAL INVESTMENT: Make it personal.
      - GENRE ACCURACY: Strictly adhere to the genre, role, and aesthetic defined in the LORE PROFILE.
      
      Output JSON with keys: arc_title, story_text.
    `;

    const narrativeResponse = await generateContentWithRetry(aiRef.current, {
      model: "gemini-3.1-pro-preview",
      contents: narrativePrompt,
      config: { responseMimeType: "application/json" }
    });

    const storyArc = JSON.parse(narrativeResponse.text || "{}");

    // --- 3. Planner Agent ---
    // Planner Agent: Groups actions into scenes and generates prompts for the image generation model.
    const plannerPrompt = `
      You are the Tactical Planner Agent for "Dreamie."
      LORE PROFILE: ${JSON.stringify(safeProfile)}
      STORY ARC: ${JSON.stringify(storyArc)}
      MAPPED ACTIONS: ${JSON.stringify(mappings)}
      
      Task: Plan the scenes for this story.
      Rules:
      - Group the actions into 2 to 3 scenes.
      - For each scene, specify which actions (by their 0-based index in the MAPPED ACTIONS array) are covered.
      - For each scene, generate 4 to 6 story pictures.
      - For each picture, provide a highly detailed 'visual_prompt' for an image generation model (incorporating the LORE PROFILE aesthetic and genre), and the accompanying 'story_beat_direction' to guide the narrative generation later.
      - IMPORTANT: The protagonist is the user. Always refer to the protagonist as "you" in the story_beat_direction. NEVER use the name "Dreamie" for the character.
      - IMPORTANT: Ensure the visual_prompt is completely safe, non-violent, and family-friendly to avoid triggering safety filters. Avoid words like 'blood', 'kill', 'strike down', 'murder', 'gore', 'weapon', 'gun', 'sword', etc. Frame action scenes heroically and peacefully.
      
      Output JSON with keys: scenes (array of objects with scene_id, actions_covered (array of integers), pictures (array of objects with visual_prompt, story_beat_direction)).
    `;

    const plannerResponse = await generateContentWithRetry(aiRef.current, {
      model: "gemini-3.1-pro-preview",
      contents: plannerPrompt,
      config: { responseMimeType: "application/json" }
    });

    const plan = JSON.parse(plannerResponse.text || "{}");
    const scenes = plan.scenes || [];

    // Assemble the final quest plan
    const questPlan = {
      arc_title: storyArc.arc_title || "Epic Quest",
      mappings,
      scenes
    };

    return questPlan;
  };

  /**
   * Handler for the "Generate Quest" button.
   * Stops the live session, captures a high-quality frame, runs the prompt chain,
   * and saves the resulting quest to the backend.
   */
  const handleGenerateQuest = async () => {
    stopLiveSession();
    setIsGenerating(true);
    
    const finalFrame = captureFrame(0.8);
    if (!finalFrame) {
      setError("Could not capture final image.");
      setIsGenerating(false);
      return;
    }

    try {
      const questPlan = await generateQuestClientSide(finalFrame);

      const { auth, db } = await import('../firebase');
      const { collection, addDoc, serverTimestamp } = await import('firebase/firestore');
      
      const user = auth.currentUser;
      if (!user) {
        throw new Error("User not authenticated");
      }

      const docRef = await addDoc(collection(db, 'users', user.uid, 'quests'), {
        uid: user.uid,
        profileId: profile.id?.toString() || "",
        arc_title: questPlan.arc_title,
        mappings: JSON.stringify(questPlan.mappings),
        scenes: JSON.stringify(questPlan.scenes),
        createdAt: serverTimestamp()
      });

      setScanResult({ questPlan, questId: docRef.id as any });
    } catch (err: any) {
      console.error("Quest generation failed:", err);
      setError(err.message || "Failed to generate quest. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white z-50 flex flex-col">
      {/* Camera View */}
      <div className="absolute inset-0 z-0">
        <video 
          ref={videoRef} 
          autoPlay 
          playsInline 
          muted 
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/80 pointer-events-none" />
        
        {/* Live Indicator */}
        {isLive && (
          <div className="absolute top-24 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-red-500/20 backdrop-blur-md px-4 py-1 rounded-full border border-red-500/50">
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="text-red-200 text-xs font-bold uppercase tracking-wider">Live Feed</span>
          </div>
        )}
      </div>

      {/* HUD */}
      <div className="relative z-10 flex-1 flex flex-col p-6">
        <header className="flex justify-between items-center">
          <button 
            onClick={onBack}
            className="p-2 bg-black/40 backdrop-blur-md rounded-full hover:bg-black/60 transition-colors"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="px-4 py-2 bg-black/40 backdrop-blur-md rounded-full border border-white/10">
            <span className="text-emerald-400 font-bold text-sm tracking-wider uppercase">
              {profile.visual_aesthetic} Mode
            </span>
          </div>
        </header>

        <div className="mt-auto space-y-6">
          <AnimatePresence mode="wait">
            {/* Error Display */}
            {error && (
              <motion.div 
                key="error"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="bg-red-500/90 text-white p-4 rounded-xl text-center text-sm font-medium backdrop-blur-sm flex flex-col gap-2"
              >
                <p>{error}</p>
                {error.includes("Camera") && (
                  <button 
                    onClick={startCamera}
                    className="bg-white/20 hover:bg-white/30 text-white text-xs py-2 px-4 rounded-lg transition-colors"
                  >
                    Retry Camera
                  </button>
                )}
              </motion.div>
            )}

            {/* Loading State during Quest Generation */}
            {isGenerating && (
               <motion.div 
               key="generating"
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: 20 }}
               className="bg-black/80 backdrop-blur-xl border border-emerald-500/30 p-8 rounded-3xl flex flex-col items-center text-center gap-4"
             >
               <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
               <div>
                 <h3 className="text-xl font-bold text-white">Tactical Analysis</h3>
                 <p className="text-zinc-400 text-sm">Processing scout report & generating mission...</p>
               </div>
             </motion.div>
            )}

            {/* Quest Generation Result */}
            {scanResult ? (
              <motion.div 
                key="result"
                initial={{ opacity: 0, y: 50 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 50 }}
                className="bg-zinc-900/90 backdrop-blur-xl border border-zinc-700 p-6 rounded-3xl shadow-2xl flex flex-col max-h-[75vh]"
              >
                <div className="shrink-0">
                  <h2 className="text-2xl font-bold text-emerald-400 mb-2">{scanResult.questPlan.arc_title}</h2>
                  <p className="text-zinc-300 text-sm mb-6 line-clamp-3">A new epic quest awaits. Complete your real-world tasks to unfold the story.</p>
                </div>
                
                <div className="space-y-3 mb-6 overflow-y-auto flex-1 min-h-0 pr-2 custom-scrollbar">
                  {scanResult.questPlan.mappings.map((m: any, i: number) => (
                    <div key={i} className="flex items-center gap-3 bg-black/40 p-3 rounded-xl border border-white/5 shrink-0">
                      <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold text-xs shrink-0">
                        {i + 1}
                      </div>
                      <div>
                        <p className="text-white text-sm font-medium">{m.fantasy_action}</p>
                        <p className="text-zinc-500 text-xs">{m.real_world_action}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="shrink-0 pt-2 space-y-3">
                  <button 
                    onClick={() => onEngage(scanResult.questId)}
                    className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all active:scale-95"
                  >
                    <Sparkles className="w-5 h-5 fill-current" />
                    Begin Quest
                  </button>

                  <button 
                    onClick={() => setShowDetails(!showDetails)}
                    className="w-full text-zinc-500 text-xs hover:text-zinc-300 transition-colors"
                  >
                    {showDetails ? "Hide Mission Data" : "Show Mission Data"}
                  </button>
                </div>

                {showDetails && (
                  <div className="mt-4 p-4 bg-black/50 rounded-xl border border-white/5 overflow-x-auto text-xs font-mono text-zinc-400">
                    <h4 className="text-emerald-500 font-bold mb-2">QUEST PLAN</h4>
                    <pre className="whitespace-pre-wrap mb-4">{JSON.stringify(scanResult.questPlan, null, 2)}</pre>
                  </div>
                )}
              </motion.div>
            ) : !isGenerating && (
              /* Initial Controls: Start Live Session or Generate Quest */
              <motion.div key="controls" className="flex flex-col items-center gap-6 pb-8 w-full">
                {isLive && (
                  <div 
                    className="w-full max-h-[40vh] overflow-y-auto flex flex-col-reverse custom-scrollbar mb-4"
                    style={{ maskImage: 'linear-gradient(to top, black 80%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to top, black 80%, transparent 100%)' }}
                  >
                    <AnimatePresence>
                      {messages.slice().reverse().map((msg) => (
                        <motion.div
                          key={msg.id}
                          initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className={`mb-3 flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                        >
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border shadow-sm mt-0.5 ${msg.role === 'user' ? 'bg-blue-500/80 border-blue-400/50' : 'bg-emerald-500/80 border-emerald-400/50'}`}>
                            {msg.role === 'user' ? <User className="w-4 h-4 text-white" /> : <Bot className="w-4 h-4 text-white" />}
                          </div>
                          <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                            <span className={`text-xs font-bold drop-shadow-md mb-0.5 ${msg.role === 'user' ? 'text-blue-300' : 'text-emerald-300'}`}>
                              {msg.role === 'user' ? 'You' : 'Scout'}
                            </span>
                            <span className="text-white text-sm font-medium drop-shadow-md leading-snug text-left">
                              {msg.text}
                              {!msg.isFinished && <span className="inline-block w-1.5 h-4 ml-1 bg-white/50 animate-pulse align-middle" />}
                            </span>
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    
                    {messages.length === 0 && (
                      <div className="text-white/80 text-sm flex items-center gap-2 drop-shadow-md mb-4 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Awaiting scout report...
                      </div>
                    )}
                  </div>
                )}

                {!isLive ? (
                  <button 
                    onClick={startLiveSession}
                    className="group relative"
                  >
                    <div className="absolute inset-0 bg-emerald-500 rounded-full blur-xl opacity-20 group-hover:opacity-40 transition-opacity" />
                    <div className="w-20 h-20 bg-zinc-900 border-2 border-emerald-500 rounded-full flex items-center justify-center relative z-10 group-active:scale-95 transition-transform">
                      <Mic className="w-8 h-8 text-emerald-500" />
                    </div>
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-sm font-medium text-emerald-400 whitespace-nowrap">
                      Deploy Scout
                    </span>
                  </button>
                ) : (
                  <div className="flex items-center gap-6">
                    <button 
                      onClick={stopLiveSession}
                      className="w-16 h-16 bg-red-500/20 border border-red-500/50 rounded-full flex items-center justify-center hover:bg-red-500/30 transition-colors"
                    >
                      <MicOff className="w-6 h-6 text-red-400" />
                    </button>
                    
                    <button 
                      onClick={handleGenerateQuest}
                      className="h-16 px-8 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-full flex items-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all active:scale-95"
                    >
                      <Sparkles className="w-5 h-5 fill-current" />
                      Generate Quest
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
