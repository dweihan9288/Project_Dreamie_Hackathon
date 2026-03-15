import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LoreProfile, QuestPlan, StoryScene, ActionMapping } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, ArrowRight, CheckCircle, PlayCircle, SkipForward } from 'lucide-react';
import { GoogleGenAI, Modality, Type, LiveServerMessage, FunctionDeclaration } from '@google/genai';
import { AudioStreamer } from '../utils/audio';
import { generateContentWithRetry } from '../utils/gemini';
import FinalBossQTE from './FinalBossQTE';

interface BattlefieldProps {
  profile: LoreProfile;
  questId: string;
  onComplete: () => void;
}

// Represents the generated assets (image and audio) for a single story picture
interface GeneratedPicture {
  imageUrl: string | null;
  audioUrl: string | null;
  generatedText: string | null;
  loading: boolean;
  error: string | null;
}

// Groups the generated pictures for a specific scene
interface SceneAssets {
  sceneId: number;
  pictures: GeneratedPicture[];
}

interface LogEntry {
  id: string;
  text: string;
  timestamp: Date;
}

/**
 * Battlefield Component
 * 
 * The execution phase of the application where the user performs the real-world tasks
 * and experiences the generated fantasy story.
 * 
 * Phases:
 * 1. 'generating': Fetches the quest plan and generates images and TTS audio in the background.
 * 2. 'supervision': Uses the device camera and MediaPipe object detection to verify task completion based on generated state machine logic.
 * 3. 'story': Plays the generated audio and displays the generated images for the completed scene.
 */
export default function Battlefield({ profile, questId, onComplete }: BattlefieldProps) {
  // State for the loaded quest plan
  const [questPlan, setQuestPlan] = useState<QuestPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // State for managing the generated assets (images and audio)
  const [sceneAssets, setSceneAssets] = useState<SceneAssets[]>([]);
  const [generatingAssets, setGeneratingAssets] = useState(false);
  const [hasStartedGeneration, setHasStartedGeneration] = useState(false);

  // State machine for the overall mission flow
  const [missionPhase, setMissionPhase] = useState<'generating' | 'supervision' | 'story' | 'qte'>('generating');
  
  // Tracking progress through the quest
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [currentActionIndexInScene, setCurrentActionIndexInScene] = useState(0);
  const [currentStoryPictureIndex, setCurrentStoryPictureIndex] = useState(0);

  // Refs for camera, object detection, and audio playback
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const videoIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const [currentAudioDuration, setCurrentAudioDuration] = useState<number>(0);

  const aiRef = useRef<GoogleGenAI | null>(null);

  // Refs to keep track of current state within the requestAnimationFrame loop
  const missionPhaseRef = useRef(missionPhase);
  useEffect(() => { missionPhaseRef.current = missionPhase; }, [missionPhase]);

  const currentSceneIndexRef = useRef(currentSceneIndex);
  useEffect(() => { currentSceneIndexRef.current = currentSceneIndex; }, [currentSceneIndex]);

  const currentActionIndexInSceneRef = useRef(currentActionIndexInScene);
  useEffect(() => { currentActionIndexInSceneRef.current = currentActionIndexInScene; }, [currentActionIndexInScene]);

  const currentStoryPictureIndexRef = useRef(currentStoryPictureIndex);
  useEffect(() => { currentStoryPictureIndexRef.current = currentStoryPictureIndex; }, [currentStoryPictureIndex]);

  const isCompletingActionRef = useRef(false);

  /**
   * Cleanup audio resources on unmount.
   */
  useEffect(() => {
    return () => {
      if (audioSourceRef.current) {
        audioSourceRef.current.onended = null;
        audioSourceRef.current.stop();
      }
      if (audioTimeoutRef.current) {
        clearTimeout(audioTimeoutRef.current);
      }
      stopLiveSession();
    };
  }, []);

  /**
   * Initialize AI client and fetch the quest plan when the component mounts or questId changes.
   */
  useEffect(() => {
    aiRef.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    fetchQuest();
  }, [questId]);

  /**
   * Trigger asset generation once the quest plan is loaded.
   */
  useEffect(() => {
    if (questPlan && !hasStartedGeneration) {
      setHasStartedGeneration(true);
      generateAssets();
    }
  }, [questPlan, hasStartedGeneration]);

  /**
   * Fetches the quest plan from the backend API.
   */
  const fetchQuest = async () => {
    try {
      const { auth, db } = await import('../firebase');
      const { doc, getDoc } = await import('firebase/firestore');
      
      const user = auth.currentUser;
      if (!user) throw new Error("User not authenticated");

      const docRef = doc(db, 'users', user.uid, 'quests', questId.toString());
      const docSnap = await getDoc(docRef);

      if (!docSnap.exists()) {
        throw new Error("Quest not found");
      }

      const data = docSnap.data();
      const questPlan = {
        arc_title: data.arc_title,
        mappings: JSON.parse(data.mappings),
        scenes: JSON.parse(data.scenes)
      };

      setQuestPlan(questPlan);
      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  /**
   * Generates images and TTS audio for all scenes in the quest plan with controlled concurrency.
   * Uses Gemini Flash Image for visuals and Gemini TTS for audio.
   */
  const generateAssets = async () => {
    if (!questPlan || !aiRef.current) return;
    setGeneratingAssets(true);
    
    // Initialize empty asset structure
    const initialAssets: SceneAssets[] = questPlan.scenes.map(scene => ({
      sceneId: scene.scene_id,
      pictures: scene.pictures.map(() => ({ imageUrl: null, audioUrl: null, generatedText: null, loading: true, error: null }))
    }));
    setSceneAssets(initialAssets);

    const base64Selfie = profile.avatar_url?.split(',')[1];
    const mimeTypeSelfie = profile.avatar_url?.split(';')[0].split(':')[1];

    const executeSequentialGeneration = async () => {
      let storyContext = "";
      
      for (let sIdx = 0; sIdx < questPlan.scenes.length; sIdx++) {
        const scene = questPlan.scenes[sIdx];
        for (let pIdx = 0; pIdx < scene.pictures.length; pIdx++) {
          const picture = scene.pictures[pIdx];
          
          try {
            // --- 1. Generate Text & Image (Interleaved with Retry Mechanism) ---
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

            const prompt = `You are a TikTok/YouTube Shorts narrator telling a fast-paced, action-packed story.
Genre: ${profile.genre}
Previous story context: ${storyContext ? storyContext : "This is the beginning of the story."}
Current story beat to write: ${picture.story_beat_direction}

TASK 1: Write the narration for this specific story beat.
- MUST be extremely concise, punchy, and fast-paced (maximum 10 to 15 words).
- MUST use simple, direct, everyday language. NO poetic metaphors, NO cryptic riddles.
- MUST match the vocabulary and tone of the Genre (${profile.genre}).
- Describe exactly what is happening literally and straightforwardly. Use short declarative sentences.
- MUST refer to the protagonist as "you" (e.g., "You grab the sword"). NEVER use the name "Dreamie".
- CRITICAL: Output ONLY the narration text. Do NOT output any scene descriptions, visual prompts, bracketed text, or meta-commentary.

TASK 2: Generate an image to accompany the story.
Visual prompt: Stylized realistic high fidelity art style, 8k resolution, cinematic lighting, masterpiece. ${picture.visual_prompt}. The scene is set in a ${profile.visual_aesthetic}. Highly detailed, sharp focus, Unreal Engine 5 render style. Use the provided image as a structural reference for the character's face.
IMPORTANT: Make the scene peaceful, heroic, and family-friendly. Do not include any violence, weapons, blood, or combat.
`;

            const imageContents: any[] = [{ text: prompt }];
            // Include selfie as reference if available
            if (base64Selfie && mimeTypeSelfie && base64Selfie !== "[Image Data Omitted]") {
               imageContents.unshift({ inlineData: { data: base64Selfie, mimeType: mimeTypeSelfie } });
            }

            let responseText = "";
            let imageUrl = null;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts && (!imageUrl || !responseText)) {
              attempts++;
              imageUrl = null;
              responseText = "";
              
              try {
                const imageResponse = await generateContentWithRetry(ai, {
                  model: 'gemini-3.1-flash-image-preview',
                  contents: { parts: imageContents },
                  config: {
                    imageConfig: { aspectRatio: "9:16", imageSize: "1K" }
                  }
                });

                for (const part of imageResponse.candidates?.[0]?.content?.parts || []) {
                  if (part.inlineData) {
                    const mime = part.inlineData.mimeType || 'image/png';
                    imageUrl = `data:${mime};base64,${part.inlineData.data}`;
                  } else if (part.text) {
                    responseText += part.text + " ";
                  }
                }
                responseText = responseText.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/{image}/gi, '').replace(/\[image\]/gi, '').trim();
                
                // Deduplicate sentences to prevent repeated outputs and filter meta-commentary
                const sentences = responseText.split(/(?<=[.!?])\s+/);
                const uniqueSentences = [];
                const seenSentences = new Set();
                const metaKeywords = [
                  'stylized', 'resolution', 'unreal engine', 'iteration', 'instructions', 
                  'narration is', 'visually,', 'the image captures', 'proceed with', 
                  'visual prompt', 'render style', 'cinematic lighting', 'masterpiece', 
                  'facial structure', 'banned concepts', 'this iteration', 'perfectly aligns',
                  '8k', 'highly detailed', 'sharp focus', 'peaceful atmosphere'
                ];

                for (const s of sentences) {
                  const trimmed = s.trim();
                  if (!trimmed) continue;
                  const lower = trimmed.toLowerCase();
                  
                  // Filter out meta-commentary
                  if (metaKeywords.some(keyword => lower.includes(keyword))) {
                    continue;
                  }

                  if (!seenSentences.has(lower)) {
                    seenSentences.add(lower);
                    uniqueSentences.push(trimmed);
                  }
                  
                  // Limit to max 4 sentences to prevent long run-on meta-commentary
                  if (uniqueSentences.length >= 4) break;
                }
                responseText = uniqueSentences.join(" ");
                
                if (imageUrl && responseText) {
                  break; // Success! Both image and text generated.
                } else {
                  console.warn(`Attempt ${attempts}: Missing image or text. Retrying...`);
                }
              } catch (e) {
                console.warn(`Attempt ${attempts} failed:`, e);
              }
            }

            // Fallback to standard flash-image model if the first attempts fail
            if (!imageUrl || !responseText) {
              console.warn(`Retrying image generation for scene ${sIdx} pic ${pIdx} without selfie...`);
              const fallbackPrompt = `You are a TikTok/YouTube Shorts narrator telling a fast-paced, action-packed story.
Genre: ${profile.genre}
Previous story context: ${storyContext ? storyContext : "This is the beginning of the story."}
Current story beat to write: ${picture.story_beat_direction}

TASK 1: Write the narration for this specific story beat.
- MUST be extremely concise, punchy, and fast-paced (maximum 10 to 15 words).
- MUST use simple, direct, everyday language. NO poetic metaphors, NO cryptic riddles.
- MUST match the vocabulary and tone of the Genre (${profile.genre}).
- Describe exactly what is happening literally and straightforwardly. Use short declarative sentences.
- MUST refer to the protagonist as "you" (e.g., "You grab the sword"). NEVER use the name "Dreamie".
- CRITICAL: Output ONLY the narration text. Do NOT output any scene descriptions, visual prompts, bracketed text, or meta-commentary.

TASK 2: Generate an image to accompany the story.
Visual prompt: Stylized realistic high fidelity art style, 8k resolution, cinematic lighting, masterpiece. ${picture.visual_prompt}. The scene is set in a ${profile.visual_aesthetic}. Highly detailed, sharp focus, Unreal Engine 5 render style. IMPORTANT: Make the scene peaceful, heroic, and family-friendly. Do not include any violence, weapons, blood, or combat.
`;
              
              let fallbackAttempts = 0;
              while (fallbackAttempts < maxAttempts && (!imageUrl || !responseText)) {
                fallbackAttempts++;
                imageUrl = null;
                responseText = "";
                
                try {
                  const fallbackResponse = await generateContentWithRetry(ai, {
                    model: 'gemini-2.5-flash-image',
                    contents: { parts: [{ text: fallbackPrompt }] },
                    config: {
                      imageConfig: { aspectRatio: "9:16" }
                    }
                  });
                  
                  for (const part of fallbackResponse.candidates?.[0]?.content?.parts || []) {
                    if (part.inlineData) {
                      const mime = part.inlineData.mimeType || 'image/png';
                      imageUrl = `data:${mime};base64,${part.inlineData.data}`;
                    } else if (part.text) {
                      responseText += part.text + " ";
                    }
                  }
                  responseText = responseText.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/{image}/gi, '').replace(/\[image\]/gi, '').trim();
                  
                  // Deduplicate sentences to prevent repeated outputs and filter meta-commentary
                  const fallbackSentences = responseText.split(/(?<=[.!?])\s+/);
                  const fallbackUniqueSentences = [];
                  const fallbackSeenSentences = new Set();
                  const fallbackMetaKeywords = [
                    'stylized', 'resolution', 'unreal engine', 'iteration', 'instructions', 
                    'narration is', 'visually,', 'the image captures', 'proceed with', 
                    'visual prompt', 'render style', 'cinematic lighting', 'masterpiece', 
                    'facial structure', 'banned concepts', 'this iteration', 'perfectly aligns',
                    '8k', 'highly detailed', 'sharp focus', 'peaceful atmosphere'
                  ];

                  for (const s of fallbackSentences) {
                    const trimmed = s.trim();
                    if (!trimmed) continue;
                    const lower = trimmed.toLowerCase();
                    
                    // Filter out meta-commentary
                    if (fallbackMetaKeywords.some(keyword => lower.includes(keyword))) {
                      continue;
                    }

                    if (!fallbackSeenSentences.has(lower)) {
                      fallbackSeenSentences.add(lower);
                      fallbackUniqueSentences.push(trimmed);
                    }
                    
                    // Limit to max 4 sentences
                    if (fallbackUniqueSentences.length >= 4) break;
                  }
                  responseText = fallbackUniqueSentences.join(" ");
                  
                  if (imageUrl && responseText) {
                    break;
                  } else {
                    console.warn(`Fallback attempt ${fallbackAttempts}: Missing image or text. Retrying...`);
                  }
                } catch (e) {
                  console.error(`Fallback attempt ${fallbackAttempts} failed:`, e);
                }
              }
            }

            if (!imageUrl) {
              throw new Error(`No image generated. Text returned: ${responseText || "None"}`);
            }

            // Append to story context
            if (responseText) {
              storyContext += "\n\n" + responseText;
            }

            // --- 2. Generate Audio (TTS) ---
            let audioUrl = null;
            if (responseText) {
              try {
                const audioResponse = await generateContentWithRetry(ai, {
                  model: "gemini-2.5-flash-preview-tts",
                  contents: [{ parts: [{ text: responseText }] }],
                  config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } },
                    },
                  },
                });

                const base64Audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                audioUrl = base64Audio ? `data:audio/pcm;rate=24000;base64,${base64Audio}` : null;
              } catch (e) {
                console.warn("TTS generation failed:", e);
              }
            }

            // Update state with generated assets
            setSceneAssets(prev => {
              const newAssets = [...prev];
              const updatedScene = { ...newAssets[sIdx] };
              const updatedPictures = [...updatedScene.pictures];
              updatedPictures[pIdx] = { imageUrl, audioUrl, generatedText: responseText, loading: false, error: null };
              updatedScene.pictures = updatedPictures;
              newAssets[sIdx] = updatedScene;
              return newAssets;
            });

          } catch (err: any) {
            console.error(`Failed to generate asset for scene ${sIdx} pic ${pIdx}`, err);
            // Update state with error
            setSceneAssets(prev => {
              const newAssets = [...prev];
              const updatedScene = { ...newAssets[sIdx] };
              const updatedPictures = [...updatedScene.pictures];
              updatedPictures[pIdx] = { imageUrl: null, audioUrl: null, generatedText: null, loading: false, error: err.message };
              updatedScene.pictures = updatedPictures;
              newAssets[sIdx] = updatedScene;
              return newAssets;
            });
          }
        }
      }
      setGeneratingAssets(false);
    };

    // We don't await the whole execution here so the user can start the mission while assets generate in the background.
    executeSequentialGeneration();
  };

  /**
   * Starts the camera.
   */
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play();
        };
      }
    } catch (err) {
      console.error("Camera error:", err);
    }
  };

  /**
   * Stops the camera.
   */
  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
    }
  };

  /**
   * Manage camera lifecycle based on mission phase.
   */
  useEffect(() => {
    if (missionPhase === 'supervision') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [missionPhase]);

  /**
   * Manage live session lifecycle based on mission phase and current action.
   */
  useEffect(() => {
    if (missionPhase === 'supervision') {
      startLiveSession();
    } else {
      stopLiveSession();
    }
    return () => {
      stopLiveSession();
    };
  }, [missionPhase, currentSceneIndex, currentActionIndexInScene]);

  useEffect(() => {
    setLogs([]);
  }, [currentSceneIndex, currentActionIndexInScene]);

  const stopLiveSession = () => {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (audioStreamerRef.current) {
      audioStreamerRef.current.close();
      audioStreamerRef.current = null;
    }
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(session => session.close()).catch(console.error);
      sessionPromiseRef.current = null;
    }
    setIsAnalyzing(false);
  };

  const startLiveSession = async () => {
    if (!questPlan || missionPhase !== 'supervision') return;
    
    stopLiveSession(); // Ensure any existing session is closed

    const currentScene = questPlan.scenes[currentSceneIndex];
    const actionIndex = currentScene?.actions_covered[currentActionIndexInScene];
    const currentAction = questPlan.mappings[actionIndex];

    if (!currentAction) return;

    setIsAnalyzing(true);

    try {
      audioStreamerRef.current = new AudioStreamer();
      
      const markTaskCompleteFunction: FunctionDeclaration = {
        name: "markTaskComplete",
        description: "Call this function ONLY when the user has successfully completed the real-world task based on visual evidence from the camera.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        }
      };

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      sessionPromiseRef.current = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        callbacks: {
          onopen: () => {
            console.log("Live session opened");
            
            // Start sending audio
            audioStreamerRef.current?.startRecording((base64Data) => {
              sessionPromiseRef.current?.then(session => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            });

            // Start sending video frames (1 fps)
            videoIntervalRef.current = setInterval(() => {
              if (!videoRef.current || !canvasRef.current || isCompletingActionRef.current) return;
              
              const video = videoRef.current;
              const canvas = canvasRef.current;
              const context = canvas.getContext('2d');
              
              if (!context || video.videoWidth === 0 || video.videoHeight === 0) return;
              
              // Scale down to save bandwidth
              const MAX_WIDTH = 640;
              const MAX_HEIGHT = 640;
              let width = video.videoWidth;
              let height = video.videoHeight;
              
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
              context.drawImage(video, 0, 0, width, height);
              
              const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
              
              sessionPromiseRef.current?.then(session => {
                session.sendRealtimeInput({
                  media: { data: base64Image, mimeType: 'image/jpeg' }
                });
              });
            }, 1000);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioStreamerRef.current) {
              audioStreamerRef.current.playAudio(base64Audio);
            }
            
            // Handle interruption
            if (message.serverContent?.interrupted && audioStreamerRef.current) {
              audioStreamerRef.current.stopPlayback();
            }

            // Handle tool calls
            const functionCalls = message.toolCall?.functionCalls;
            if (functionCalls && functionCalls.length > 0) {
              for (const call of functionCalls) {
                if (call.name === 'markTaskComplete') {
                  console.log("Task marked complete by Gemini Live!");
                  
                  // Send response back
                  sessionPromiseRef.current?.then(session => {
                    session.sendToolResponse({
                      functionResponses: [{
                        name: call.name,
                        id: call.id,
                        response: { result: "success" }
                      }]
                    });
                  });

                  // Trigger UI transition
                  handleActionComplete();
                }
              }
            }
          },
          onerror: (error) => {
            console.error("Live session error:", error);
          },
          onclose: () => {
            console.log("Live session closed");
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Fenrir" } },
          },
          systemInstruction: `You are Dreamie, a supportive and heroic AI companion. The user is currently trying to complete the real-world task: "${currentAction.real_world_action}". This is mapped to their thematic quest: "${currentAction.fantasy_action}". Observe their environment through the camera. Encourage them verbally. If they ask if they are done, look closely at the camera feed. If the task is visibly complete, praise them enthusiastically and IMMEDIATELY call the markTaskComplete tool. If it is not complete, tell them what they still need to do. Keep your responses brief and encouraging. Match the tone and vocabulary of the user's chosen genre: ${profile.genre}.`,
          tools: [{ functionDeclarations: [markTaskCompleteFunction] }]
        }
      });
    } catch (err) {
      console.error("Failed to start live session:", err);
      setIsAnalyzing(false);
    }
  };

  /**
   * Called when a real-world action is successfully verified.
   * Advances to the next action or transitions to the story phase if the scene is complete.
   */
  const handleActionComplete = () => {
    if (isCompletingActionRef.current) return;
    isCompletingActionRef.current = true;
    
    if (!questPlan) return;
    const currentScene = questPlan.scenes[currentSceneIndexRef.current];
    
    if (currentActionIndexInSceneRef.current < currentScene.actions_covered.length - 1) {
      // Move to next action in the current scene
      setCurrentActionIndexInScene(prev => prev + 1);
      setTimeout(() => { isCompletingActionRef.current = false; }, 1000);
    } else {
      // Scene complete, transition to story phase
      setCurrentAudioDuration(0);
      setMissionPhase('story');
      setCurrentStoryPictureIndex(0);
      setTimeout(() => { isCompletingActionRef.current = false; }, 1000);
    }
  };

  /**
   * Initiates playback of the audio for a specific story picture.
   */
  const playCurrentStoryPicture = (picIndex: number) => {
    const sIdx = currentSceneIndexRef.current;
    const asset = sceneAssets[sIdx]?.pictures[picIndex];
    if (asset?.audioUrl) {
      // Decode base64 PCM and play via Web Audio API
      playPcmAudio(asset.audioUrl);
    }
  };

  useEffect(() => {
    if (missionPhase === 'story') {
      const sIdx = currentSceneIndex;
      const pIdx = currentStoryPictureIndex;
      const asset = sceneAssets[sIdx]?.pictures[pIdx];
      
      // If we are in the story phase, the asset just finished loading, and audio is not currently playing
      if (asset && !asset.loading && !audioSourceRef.current && !audioTimeoutRef.current) {
        if (asset.audioUrl) {
          playCurrentStoryPicture(pIdx);
        } else {
          // If it failed to load audio (or error), skip after a short delay
          audioTimeoutRef.current = setTimeout(handleStoryPictureComplete, 3000);
        }
      }
    }
  }, [missionPhase, currentSceneIndex, currentStoryPictureIndex, sceneAssets]);

  /**
   * Decodes and plays raw PCM audio data using the Web Audio API.
   */
  const playPcmAudio = async (base64Data: string) => {
    try {
      setCurrentAudioDuration(0); // Reset duration so subtitles hide while decoding
      // Cleanup previous audio
      if (audioSourceRef.current) {
        audioSourceRef.current.onended = null;
        audioSourceRef.current.stop();
        audioSourceRef.current = null;
      }
      if (audioTimeoutRef.current) {
        clearTimeout(audioTimeoutRef.current);
        audioTimeoutRef.current = null;
      }

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const binaryString = atob(base64Data.split(',')[1]);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Convert to 16-bit PCM
      const buffer = new Int16Array(bytes.buffer);
      const audioBuffer = audioCtx.createBuffer(1, buffer.length, 24000);
      setCurrentAudioDuration(audioBuffer.duration);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        channelData[i] = buffer[i] / 32768.0;
      }
      
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = () => {
        audioSourceRef.current = null;
        handleStoryPictureComplete();
      };
      source.start();
      audioSourceRef.current = source;
    } catch (e) {
      console.error("Audio playback failed", e);
      setCurrentAudioDuration(5); // Fallback duration so subtitles still show
      // Fallback if audio fails to play, advance after a delay
      audioTimeoutRef.current = setTimeout(handleStoryPictureComplete, 5000);
    }
  };

  /**
   * Called when the audio for a story picture finishes playing.
   * Advances to the next picture, or back to supervision for the next scene, or completes the quest.
   */
  const handleStoryPictureComplete = () => {
    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null;
      audioSourceRef.current.stop();
      audioSourceRef.current = null;
    }
    if (audioTimeoutRef.current) {
      clearTimeout(audioTimeoutRef.current);
      audioTimeoutRef.current = null;
    }

    setCurrentAudioDuration(0);

    if (!questPlan) return;
    const sIdx = currentSceneIndexRef.current;
    const pIdx = currentStoryPictureIndexRef.current;
    const currentScene = questPlan.scenes[sIdx];
    
    if (pIdx < currentScene.pictures.length - 1) {
      // Next picture in current scene
      const nextIdx = pIdx + 1;
      setCurrentStoryPictureIndex(nextIdx);
    } else {
      // Scene complete
      if (sIdx < questPlan.scenes.length - 1) {
        // Move to next scene's supervision phase
        setCurrentSceneIndex(prev => prev + 1);
        setCurrentActionIndexInScene(0);
        setMissionPhase('supervision');
      } else {
        // Quest complete, trigger Final Boss QTE
        setMissionPhase('qte');
      }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center text-emerald-500">
        <Loader2 className="w-12 h-12 animate-spin mb-4" />
        <p className="font-bold tracking-widest uppercase">Initializing Battlefield...</p>
      </div>
    );
  }

  if (error || !questPlan) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6 text-center">
        <div className="bg-red-500/20 text-red-400 p-6 rounded-2xl border border-red-500/50 max-w-md">
          <h2 className="text-xl font-bold mb-2">Mission Aborted</h2>
          <p>{error || "Quest data missing"}</p>
          <button onClick={onComplete} className="mt-6 px-6 py-2 bg-red-500 text-white rounded-full font-bold">
            Return to Base
          </button>
        </div>
      </div>
    );
  }

  if (missionPhase === 'qte') {
    return <FinalBossQTE profile={profile} onComplete={onComplete} />;
  }

  if (missionPhase === 'generating') {
    const isFirstSceneReady = sceneAssets[0]?.pictures.every(p => !p.loading);

    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col p-6">
        <header className="mb-8 flex flex-col md:flex-row md:justify-between md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-emerald-400 mb-2">Forging the Narrative</h1>
            <p className="text-zinc-400">
              Generating cinematic scenes and narration for your epic quest...
            </p>
          </div>
          <button
            onClick={() => setMissionPhase('supervision')}
            disabled={!isFirstSceneReady}
            className={`px-6 py-3 font-bold rounded-xl flex items-center justify-center gap-2 transition-colors shrink-0 ${!isFirstSceneReady ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-[0_0_20px_rgba(16,185,129,0.3)]'}`}
          >
            Start Mission <ArrowRight className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 md:pr-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <AnimatePresence>
              {sceneAssets.map((scene, sIdx) => 
                scene.pictures.map((pic, pIdx) => (
                  <SceneCard key={`${sIdx}-${pIdx}`} pic={pic} sIdx={sIdx} pIdx={pIdx} />
                ))
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    );
  }

  if (missionPhase === 'supervision') {
    const currentScene = questPlan?.scenes[currentSceneIndex];
    const actionIndex = currentScene?.actions_covered[currentActionIndexInScene];
    const currentAction = questPlan?.mappings[actionIndex as number];
    const shortGoal = currentAction?.real_world_action || "Perform Task";

    return (
      <div className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center">
        <video 
          ref={videoRef} 
          className="absolute inset-0 w-full h-full object-cover" 
          playsInline 
          muted 
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {/* HUD Overlays */}
        <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
          {/* Top Section: Current Goal */}
          <div className="pt-6 px-4 flex justify-center">
            <div className="bg-black/40 backdrop-blur-md border border-white/10 px-6 py-3 rounded-full shadow-lg max-w-[90%] w-max text-center">
              <span className="text-xs text-emerald-300 uppercase tracking-widest font-semibold block mb-1">Current Goal</span>
              <span className="text-white font-medium drop-shadow-md">{shortGoal}</span>
            </div>
          </div>

          {/* Bottom Section: Controls */}
          <div className="flex flex-col justify-end p-4 pb-6 gap-4 h-full pointer-events-auto bg-gradient-to-t from-black/80 via-black/20 to-transparent">
            
            <div className="flex-1 flex flex-col justify-end items-center pb-8">
               <div className="flex items-center gap-3 bg-black/50 backdrop-blur-md px-6 py-3 rounded-full border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
                  <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse"></div>
                  <span className="text-emerald-300 font-medium tracking-wide">Live Audio & Vision Active</span>
               </div>
               <p className="text-white/70 text-sm mt-4 text-center max-w-xs">
                 Talk to Dreamie! Ask if you are done when you finish the task.
               </p>
            </div>

            {/* Controls Bar */}
            <div className="flex items-center justify-between w-full mt-2">
              <button 
                onClick={onComplete}
                className="bg-red-500/80 hover:bg-red-500 backdrop-blur-md text-white px-6 py-3 rounded-full font-semibold flex items-center gap-2 shadow-lg transition-colors"
              >
                Abort
              </button>
              
              <div className="flex items-center gap-3">
                <button 
                  onClick={handleActionComplete}
                  className="bg-white/20 hover:bg-white/30 text-white px-4 py-3 rounded-full font-bold text-xs transition-colors backdrop-blur-md shadow-lg"
                >
                  Force Complete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (missionPhase === 'story') {
    const asset = sceneAssets[currentSceneIndex]?.pictures[currentStoryPictureIndex];
    const text = asset?.generatedText;

    return (
      <div className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${currentSceneIndex}-${currentStoryPictureIndex}`}
            initial={{ opacity: 0, scale: 1.05 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1 }}
            className="absolute inset-0"
          >
            {asset?.loading ? (
              <div className="w-full h-full flex flex-col items-center justify-center text-emerald-500">
                <Loader2 className="w-12 h-12 animate-spin mb-4" />
                <span className="text-sm font-medium animate-pulse">Rendering Scene...</span>
              </div>
            ) : asset?.imageUrl ? (
              <img 
                src={asset.imageUrl} 
                alt="Story Scene" 
                className="w-full h-full object-cover opacity-80"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
          </motion.div>
        </AnimatePresence>

        {!asset?.loading && text && currentAudioDuration > 0 && (
          <StorySubtitles text={text} duration={currentAudioDuration} />
        )}

        <button 
          onClick={handleStoryPictureComplete}
          className="absolute bottom-8 right-8 bg-white/10 hover:bg-white/20 backdrop-blur-md text-white px-4 py-2 rounded-full flex items-center gap-2 transition-colors text-sm z-20"
        >
          Skip <SkipForward className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return null;
}

/**
 * Renders TikTok-style subtitles that reveal in chunks synchronized with the audio duration.
 */
const StorySubtitles = ({ text, duration }: { text: string, duration: number }) => {
  const [visibleChunk, setVisibleChunk] = useState('');
  
  useEffect(() => {
    if (!duration || duration <= 0) {
      setVisibleChunk(text);
      return;
    }
    
    // Split text into phrases based on punctuation (comma, full stop, exclamation mark, question mark)
    const chunks = text.split(/(?<=[.,!?])\s+/).filter(chunk => chunk.trim().length > 0);
    
    if (chunks.length === 0) {
      setVisibleChunk(text);
      return;
    }
    
    // Calculate timing for each chunk based on its character length
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const chunkTimings = chunks.map(chunk => (chunk.length / totalLength) * duration);
    
    const chunkStartTimes = [0];
    for (let i = 0; i < chunkTimings.length - 1; i++) {
      chunkStartTimes.push(chunkStartTimes[i] + chunkTimings[i]);
    }
    
    setVisibleChunk(chunks[0]);
    const startTime = Date.now();
    let animationFrameId: number;
    
    const updateSubtitle = () => {
      const elapsed = (Date.now() - startTime) / 1000; // in seconds
      if (elapsed >= duration) {
        setVisibleChunk(chunks[chunks.length - 1]);
        return;
      }
      
      // Find the current chunk based on elapsed time
      let currentChunkIdx = 0;
      for (let i = chunkStartTimes.length - 1; i >= 0; i--) {
        if (elapsed >= chunkStartTimes[i]) {
          currentChunkIdx = i;
          break;
        }
      }
      
      setVisibleChunk(chunks[currentChunkIdx]);
      animationFrameId = requestAnimationFrame(updateSubtitle);
    };
    
    animationFrameId = requestAnimationFrame(updateSubtitle);
    
    return () => cancelAnimationFrame(animationFrameId);
  }, [text, duration]);

  return (
    <div className="absolute inset-x-0 bottom-24 flex justify-center px-6 pointer-events-none z-10">
      <p className={`font-black text-white text-center uppercase tracking-wide leading-tight ${visibleChunk.length > 50 ? 'text-xl md:text-3xl' : visibleChunk.length > 30 ? 'text-2xl md:text-4xl' : 'text-3xl md:text-5xl'}`}
         style={{ 
           WebkitTextStroke: '1px black',
           textShadow: '0 4px 24px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,1)' 
         }}>
        {visibleChunk}
      </p>
    </div>
  );
};

/**
 * Renders a single scene card in the "Forging the Narrative" phase.
 */
const SceneCard = ({ pic, sIdx, pIdx }: { pic: GeneratedPicture, sIdx: number, pIdx: number }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: (sIdx * 2 + pIdx) * 0.1 }}
      className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col shadow-xl"
    >
      <div className="aspect-video bg-zinc-900 relative flex items-center justify-center overflow-hidden" style={{ backgroundImage: 'radial-gradient(#3f3f46 1px, transparent 1px)', backgroundSize: '16px 16px' }}>
        {pic.loading ? (
          <div className="flex flex-col items-center text-emerald-500">
            <Loader2 className="w-8 h-8 animate-spin mb-2" />
            <span className="text-xs font-medium animate-pulse">Rendering Scene {sIdx + 1}...</span>
          </div>
        ) : pic.error ? (
          <div className="text-red-400 text-center p-4">
            <p className="text-xs font-bold mb-1">Generation Failed</p>
            <p className="text-[10px] opacity-70">{pic.error}</p>
          </div>
        ) : pic.imageUrl ? (
          <motion.img 
            initial={{ opacity: 0, scale: 1.1 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
            src={pic.imageUrl} 
            alt="Scene" 
            className="w-full h-full object-cover" 
            referrerPolicy="no-referrer"
          />
        ) : null}
      </div>
      <div className="p-4 flex-1 flex flex-col justify-between bg-zinc-900/80 backdrop-blur-sm">
        <div>
          <h3 className="font-bold text-emerald-400 text-sm mb-1">Scene {sIdx + 1} - Part {pIdx + 1}</h3>
          {!pic.loading && pic.generatedText ? (
            <div className="mt-2">
              <p className={`text-zinc-300 text-xs ${isExpanded ? '' : 'line-clamp-2'}`}>
                {pic.generatedText}
              </p>
              <button 
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-emerald-500 text-[10px] font-bold uppercase mt-2 hover:text-emerald-400 transition-colors"
              >
                {isExpanded ? 'Show Less' : 'Read More'}
              </button>
            </div>
          ) : pic.loading ? (
            <div className="mt-2 space-y-2">
              <div className="h-2 bg-zinc-800 rounded w-3/4 animate-pulse"></div>
              <div className="h-2 bg-zinc-800 rounded w-1/2 animate-pulse"></div>
            </div>
          ) : (
            <p className="text-zinc-500 text-xs italic">No text generated.</p>
          )}
        </div>
      </div>
    </motion.div>
  );
};

