import React, { useState, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Text, Line } from '@react-three/drei';
import * as THREE from 'three';
import { Play, Settings } from 'lucide-react';
import { LoreProfile } from '../types';
import { generateContentWithRetry, generateVideosWithRetry } from '../utils/gemini';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

/**
 * Extracts the last frame of a video as a base64 encoded JPEG string.
 * This is used to seamlessly chain video generation by using the last frame
 * of the previous video as the starting image for the next.
 * 
 * @param videoUrl The URL of the video to extract the frame from.
 * @returns A promise that resolves to the base64 encoded image data.
 */
const extractLastFrame = (videoUrl: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    
    video.style.position = 'absolute';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    video.src = videoUrl;

    video.onloadedmetadata = () => {
      if (!isFinite(video.duration)) {
        video.currentTime = 1e6;
      } else {
        video.currentTime = Math.max(0, video.duration - 0.1);
      }
    };

    let hasSeekedToEnd = false;

    video.onseeked = () => {
      if (!isFinite(video.duration) && !hasSeekedToEnd) {
        hasSeekedToEnd = true;
        video.currentTime = Math.max(0, video.currentTime - 0.1);
        return;
      }
      
      setTimeout(() => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
            document.body.removeChild(video);
            resolve(dataUrl.split(',')[1]);
          } else {
            document.body.removeChild(video);
            reject(new Error('Failed to get canvas context'));
          }
        } catch (e) {
          document.body.removeChild(video);
          reject(e);
        }
      }, 150);
    };

    video.onerror = (e) => {
      document.body.removeChild(video);
      reject(e);
    };
    
    video.load();
  });
};

/**
 * A Three.js component that renders a video as a background texture on a plane.
 * It automatically scales to cover the viewport while maintaining the video's aspect ratio.
 * 
 * @param video The HTMLVideoElement to render.
 * @param visible Whether the video plane should be visible.
 */
function VideoBackground({ video, visible }: { video: HTMLVideoElement | null, visible: boolean }) {
  const { viewport } = useThree();
  const [texture, setTexture] = useState<THREE.VideoTexture | null>(null);
  const [videoAspect, setVideoAspect] = useState(16/9);

  useEffect(() => {
    if (!video) return;
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    setTexture(tex);

    const updateAspect = () => {
      if (video.videoWidth && video.videoHeight) {
        setVideoAspect(video.videoWidth / video.videoHeight);
      }
    };
    
    video.addEventListener('loadedmetadata', updateAspect);
    if (video.readyState >= 1) {
      updateAspect();
    }

    return () => {
      video.removeEventListener('loadedmetadata', updateAspect);
      tex.dispose();
    };
  }, [video]);

  useEffect(() => {
    if (!texture) return;
    const planeAspect = viewport.width / viewport.height;
    
    if (videoAspect > planeAspect) {
      const scale = planeAspect / videoAspect;
      texture.repeat.set(scale, 1);
      texture.offset.set((1 - scale) / 2, 0);
    } else {
      const scale = videoAspect / planeAspect;
      texture.repeat.set(1, scale);
      texture.offset.set(0, (1 - scale) / 2);
    }
  }, [videoAspect, viewport.width, viewport.height, texture]);

  if (!texture) return null;

  return (
    <mesh visible={visible}>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <meshBasicMaterial map={texture} />
    </mesh>
  );
}

/**
 * Renders a progress bar that syncs with the active video's playback time.
 * 
 * @param video The currently playing video element.
 * @param isPlaying Whether the video is currently playing.
 */
function ProgressBar({ video, isPlaying }: { video: HTMLVideoElement | null, isPlaying: boolean }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!video) return;
    let animationFrameId: number;

    const updateProgress = () => {
      if (video.duration) {
        setProgress(video.currentTime / video.duration);
      }
      if (isPlaying) {
        animationFrameId = requestAnimationFrame(updateProgress);
      }
    };

    updateProgress();

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [video, isPlaying]);

  if (!video) return null;

  return (
    <div className="w-full flex flex-col items-center gap-1.5">
      <div className="text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase">Time Remaining</div>
      <div className="w-full h-2.5 bg-zinc-800/80 rounded-full overflow-hidden border border-white/10 backdrop-blur-md shadow-inner">
        <div 
          className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.8)]"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

const PATTERNS = [
  [[-0.3, 0.4], [0.3, 0.4]],
  [[0, 0.6], [0, -0.6]],
  [[-0.3, 0.4], [0, -0.4], [0.3, 0.4]],
  [[-0.3, -0.4], [0, 0.4], [0.3, -0.4]],
  [[-0.3, 0.4], [0.3, 0.4], [-0.3, -0.4], [0.3, -0.4]],
  [[0.3, 0.4], [-0.3, 0.4], [0.3, -0.4], [-0.3, -0.4]],
  [[-0.3, 0.4], [0.3, 0.4], [0.3, -0.4], [-0.3, -0.4], [-0.3, 0.4]],
];

/**
 * The core QTE (Quick Time Event) game logic component.
 * It manages the drawing mechanics, pattern matching, and game state (win/lose).
 * 
 * @param video The main QTE video element, used to sync game logic with video playback.
 * @param phase The current phase of the Final Boss encounter.
 * @param hasWon Whether the user has successfully completed the QTE.
 * @param onWin Callback triggered when the user successfully completes all patterns.
 */
function DrawingQTE({ video, phase, hasWon, onWin }: { video: HTMLVideoElement | null, phase: string, hasWon: boolean, onWin: () => void }) {
  const { viewport } = useThree();
  const [patterns, setPatterns] = useState<number[][][]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [targetWaypoint, setTargetWaypoint] = useState(0);
  const [isDrawing, setIsDrawing] = useState(false);
  const [userPath, setUserPath] = useState<THREE.Vector3[]>([]);
  
  const currentIndexRef = useRef(0);
  const targetWaypointRef = useRef(0);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    targetWaypointRef.current = targetWaypoint;
  }, [targetWaypoint]);

  useEffect(() => {
    if (phase === 'playing_main' && !hasWon) {
      const selected = [];
      for(let i=0; i<3; i++) {
        selected.push(PATTERNS[Math.floor(Math.random() * PATTERNS.length)]);
      }
      setPatterns(selected);
      setCurrentIndex(0);
      currentIndexRef.current = 0;
      setTargetWaypoint(0);
      targetWaypointRef.current = 0;
      setUserPath([]);
      setIsDrawing(false);
    }
  }, [phase, hasWon]);

  if (phase !== 'playing_main') return null;

  if (hasWon) {
    return (
      <group position={[0, 0, 0.1]}>
        <Text fontSize={0.8} color="#00ff00" anchorX="center" anchorY="middle" outlineWidth={0.04} outlineColor="#000">
          SUCCESS!
        </Text>
      </group>
    );
  }

  const currentPattern = patterns[currentIndex];
  if (!currentPattern) return null;

  const threshold = Math.min(viewport.width, viewport.height) * 0.15;

  const checkWaypoint = (point: THREE.Vector3) => {
    const currentIdx = currentIndexRef.current;
    const targetWp = targetWaypointRef.current;
    
    const currentPattern = patterns[currentIdx];
    if (!currentPattern) return;
    
    const target = currentPattern[targetWp];
    if (!target) return;
    
    const targetVec = new THREE.Vector3(target[0] * viewport.width, target[1] * viewport.width, 0);
    
    if (point.distanceTo(targetVec) < threshold) {
      if (targetWp === currentPattern.length - 1) {
        if (currentIdx === 2) {
          onWin();
        } else {
          setCurrentIndex(currentIdx + 1);
          currentIndexRef.current = currentIdx + 1;
          setTargetWaypoint(0);
          targetWaypointRef.current = 0;
          setUserPath([]);
          setIsDrawing(false);
        }
      } else {
        setTargetWaypoint(targetWp + 1);
        targetWaypointRef.current = targetWp + 1;
        setUserPath(prev => {
          if (prev.length === 0) return [targetVec, point];
          const newPath = [...prev];
          newPath[newPath.length - 1] = targetVec;
          newPath.push(point);
          return newPath;
        });
      }
    }
  };

  const handlePointerDown = (e: any) => {
    e.stopPropagation();
    if (e.target.setPointerCapture) {
      e.target.setPointerCapture(e.pointerId);
    }
    setIsDrawing(true);
    const p = e.point.clone();
    p.z = 0;
    setUserPath([p, p.clone()]);
    checkWaypoint(p);
  };

  const handlePointerMove = (e: any) => {
    if (!isDrawing) return;
    e.stopPropagation();
    const p = e.point.clone();
    p.z = 0;
    
    setUserPath(prev => {
      if (prev.length < 2) return [p, p.clone()];
      const newPath = [...prev];
      newPath[newPath.length - 1] = p;
      return newPath;
    });
    
    checkWaypoint(p);
  };

  const handlePointerUp = (e: any) => {
    e.stopPropagation();
    if (e.target.releasePointerCapture && e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) {
      e.target.releasePointerCapture(e.pointerId);
    }
    setIsDrawing(false);
    setUserPath([]);
    
    const currentIdx = currentIndexRef.current;
    const targetWp = targetWaypointRef.current;
    const currentPattern = patterns[currentIdx];
    
    if (currentPattern && targetWp < currentPattern.length) {
      setTargetWaypoint(0);
      targetWaypointRef.current = 0;
    }
  };

  const patternPoints = currentPattern.map(p => new THREE.Vector3(p[0] * viewport.width, p[1] * viewport.width, 0));

  return (
    <group position={[0, 0, 0.1]}>
      <mesh 
        visible={false} 
        position={[0, 0, 0]} 
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerOut={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <planeGeometry args={[viewport.width, viewport.height]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      <Line 
        points={patternPoints} 
        color="rgba(255, 255, 255, 0.3)" 
        lineWidth={8} 
      />

      {patternPoints.map((p, i) => {
        const isHit = i < targetWaypoint;
        const isNext = i === targetWaypoint;
        return (
          <mesh position={p} key={i}>
            <circleGeometry args={[threshold * 0.6, 32]} />
            <meshBasicMaterial 
              color={isHit ? "#00ff00" : (isNext ? "#00d8ff" : "#ffffff")} 
              transparent 
              opacity={isHit ? 0.6 : (isNext ? 0.8 : 0.2)} 
            />
            {isNext && (
              <mesh>
                <ringGeometry args={[threshold * 0.6, threshold * 0.75, 32]} />
                <meshBasicMaterial color="#00d8ff" />
              </mesh>
            )}
          </mesh>
        );
      })}

      {userPath.length > 1 && (
        <Line points={userPath} color="#00d8ff" lineWidth={6} />
      )}

      <Text position={[0, viewport.height / 2 - 0.5, 0]} fontSize={0.4} color="white" anchorX="center" anchorY="top" outlineWidth={0.02} outlineColor="#000">
        PATTERN {currentIndex + 1} / 3
      </Text>
    </group>
  );
}

/**
 * Renders the result overlay (WIN or LOSE) after the QTE game concludes.
 * 
 * @param phase The current phase of the Final Boss encounter.
 * @param hasWon Whether the user won the QTE.
 */
function ResultOverlay({ phase, hasWon }: { phase: string, hasWon: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  
  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
    }
  });

  if (phase !== 'ended') return null;

  return (
    <group ref={groupRef} scale={[0.1, 0.1, 0.1]} position={[0, 0, 1]}>
      <Text 
        position={[0, 0, 0]} 
        fontSize={1.5} 
        color={hasWon ? "#00ff00" : "#ff0000"} 
        anchorX="center" 
        anchorY="middle"
        outlineWidth={0.05}
        outlineColor="#000000"
        fontWeight="bold"
      >
        {hasWon ? "YOU WIN!" : "YOU LOSE!"}
      </Text>
    </group>
  );
}

interface FinalBossQTEProps {
  profile: LoreProfile;
  onComplete: () => void;
}

/**
 * FinalBossQTE Component
 * 
 * The climactic finale of the quest. It generates a sequence of 4 videos using Veo 3.1:
 * 1. Buildup: The boss appears.
 * 2. Main QTE: The interactive drawing game where the user must draw patterns to attack.
 * 3. Win: The boss is defeated (played if the user wins the QTE).
 * 4. Lose: The user is defeated (played if the user loses the QTE).
 * 
 * The videos are generated sequentially, using the last frame of the previous video
 * to ensure visual continuity.
 */
export default function FinalBossQTE({ profile, onComplete }: FinalBossQTEProps) {
  const [videos, setVideos] = useState<{ buildup: string | null, main: string | null, win: string | null, lose: string | null }>({ buildup: null, main: null, win: null, lose: null });
  const [phase, setPhase] = useState<'setup' | 'idle' | 'playing_buildup' | 'playing_main' | 'playing_win' | 'playing_lose' | 'ended'>('setup');
  
  const [generationStatus, setGenerationStatus] = useState<string>('Initializing Final Boss...');
  const [generationError, setGenerationError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const generateAllAssets = async () => {
      try {
        const { GoogleGenAI, Type } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

        const fantasyPrompt = `${profile.character_role} in a ${profile.genre} setting. Enemies: ${profile.primary_enemies}. Aesthetic: ${profile.visual_aesthetic}. Motivation: ${profile.core_motivation}`;
        const userPhoto = profile.avatar_url;

        if (!userPhoto) {
          throw new Error("User photo is missing.");
        }

        // 1. Frame A
        setGenerationStatus('Generating Frame A...');
        const plannerPromptA = `
You are the Master Art Director for a dynamic visual generation engine. Your job is to analyze a user's raw fantasy scenario and translate it into three highly vivid, spatially aware descriptions formatted strictly as a JSON object.

Your ultimate goal for Frame A is Anticipation and Scale. Frame A is the moment before the action. You must establish a deep, narrow "corridor" perspective that makes the user's avatar look powerful in the immediate foreground, while their challenge looms distantly in the background.

JSON Keys & Grammatical Handshakes:
1. environment_description: Starts directly with the noun phrase. Create a natural "corridor" that forces the viewer's eye upward and backward using towering elements to frame the left and right sides.
2. character_description: Describe the user's avatar. Focus on their attire, physical tension, and how the environmental lighting interacts with their materials.
3. adversary_description: Describe the focal point of the challenge. Make it feel imposing, appropriately scaled for the deep background, and highly atmospheric.

User Fantasy: ${fantasyPrompt}
        `;

        const planResponseA = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-pro-preview',
          contents: plannerPromptA,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                environment_description: { type: Type.STRING },
                character_description: { type: Type.STRING },
                adversary_description: { type: Type.STRING }
              },
              required: ['environment_description', 'character_description', 'adversary_description']
            }
          }
        });

        const planA = JSON.parse(planResponseA.text || '{}');

        const imagePromptA = `
- Stylized realistic high fidelity art style, 8k resolution, cinematic lighting, masterpiece, portrait image optimized for smartphone (9:16 aspect ratio).
- A low-angle, narrow perspective looking up a ${planA.environment_description}
- In the close-up foreground, ${planA.character_description}
- Character is seen from behind and slightly below from mid-thigh up, in a poised posture and turned away from the front; The face, **BASED ON THE PROVIDED REFERENCE IMAGE**, is looking directly into the camera lens, making intense eye contact with the viewer.
- Deep in the background, positioned much further back and higher in the vertical frame, and facing the character, is the ${planA.adversary_description}
- Highly detailed textures, photorealistic details, sharp focus, Unreal Engine 5 render style.
        `;

        const base64DataA = userPhoto.split(',')[1];
        const mimeTypeA = userPhoto.split(';')[0].split(':')[1];

        const imageResponseA = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-flash-image-preview',
          contents: {
            parts: [
              { inlineData: { data: base64DataA, mimeType: mimeTypeA } },
              { text: imagePromptA },
            ],
          },
          config: {
            imageConfig: { aspectRatio: "9:16", imageSize: "1K" }
          }
        });

        let generatedImageUrlA = null;
        if (imageResponseA.candidates && imageResponseA.candidates.length > 0) {
          const parts = imageResponseA.candidates[0].content?.parts || [];
          for (const part of parts) {
            if (part.inlineData) {
              const mime = part.inlineData.mimeType || 'image/png';
              generatedImageUrlA = `data:${mime};base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (!generatedImageUrlA) throw new Error("Failed to generate Frame A.");

        // 2. Frame B
        setGenerationStatus('Generating Frame B...');
        const plannerPromptB = `
You are the Master Action Director for a dynamic visual generation engine. Your job is to analyze a user's raw fantasy scenario and the provided Frame A image, then translate the climax of their action into four highly vivid, spatially aware descriptions formatted strictly as a JSON object.

Your ultimate goal for Frame B is The Climax of Contact. This is the exact moment the two opposing forces meet. The most critical rule of Frame B is that the user's force (foreground) and the adversary's force (background) MUST physically meet or lock in the exact dead center of the vertical frame, creating a massive, sustained visual anchor for the player's Quick Time Event (QTE).

JSON Keys & Grammatical Handshakes:
1. character_state_description: Describe the user's avatar in the active execution of their offensive or defensive action. What physical force, energy, or momentum are they projecting forward?
2. adversary_state_description: Describe the adversary's active counter-force. This must be the exact opposing energy, attack, or physical resistance moving toward the foreground character.
3. qte_description: Describe the violent, sustained collision of the two forces. Crucial: You must explicitly state that the forces collide/meet in the "dead center of the vertical frame," creating a massive, glowing, or chaotic focal point.
4. effects_aesthetics: List the specific post-processing and particle effects that elevate the intensity and visual fidelity of the collision.

User Fantasy: ${fantasyPrompt}
        `;

        const base64DataGenA = generatedImageUrlA.split(',')[1];
        const mimeTypeGenA = generatedImageUrlA.split(';')[0].split(':')[1];

        const planResponseB = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-pro-preview',
          contents: {
            parts: [
              { inlineData: { data: base64DataGenA, mimeType: mimeTypeGenA } },
              { text: plannerPromptB },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                character_state_description: { type: Type.STRING },
                adversary_state_description: { type: Type.STRING },
                qte_description: { type: Type.STRING },
                effects_aesthetics: { type: Type.STRING }
              },
              required: ['character_state_description', 'adversary_state_description', 'qte_description', 'effects_aesthetics']
            }
          }
        });

        const planB = JSON.parse(planResponseB.text || '{}');

        const imagePromptB = `
- Cinematic 4K portrait image (9:16 aspect ratio), matching the exact environment from the provided image.
- In the close-up foreground, the main character is now seen entirely from behind, with the back of the head facing the camera, while looking straight ahead at the distance.
- ${planB.character_state_description}
- In the distant background, ${planB.adversary_state_description}
- ${planB.qte_description}
- ${planB.effects_aesthetics}
        `;

        const imageResponseB = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-flash-image-preview',
          contents: {
            parts: [
              { inlineData: { data: base64DataGenA, mimeType: mimeTypeGenA } },
              { text: imagePromptB },
            ],
          },
          config: {
            imageConfig: { aspectRatio: "9:16", imageSize: "1K" }
          }
        });

        let generatedImageUrlB = null;
        if (imageResponseB.candidates && imageResponseB.candidates.length > 0) {
          const parts = imageResponseB.candidates[0].content?.parts || [];
          for (const part of parts) {
            if (part.inlineData) {
              const mime = part.inlineData.mimeType || 'image/png';
              generatedImageUrlB = `data:${mime};base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (!generatedImageUrlB) throw new Error("Failed to generate Frame B.");

        // 3. Build Up Video
        setGenerationStatus('Generating Build Up Video...');
        const plannerPromptBuildUp = `
You are the Master Video Sequencer for a dynamic AI video generation engine. Your job is to analyze a user's raw fantasy scenario and the provided Frame A and Frame B images, then translate the initiation of their action into two highly vivid, kinetically aware descriptions formatted strictly as a JSON object.

Your ultimate goal for the Build-Up is Kinetic Travel to Frozen Climax. The AI video model wants to make explosions fade away. You must force it to hold the climax by describing the collision as a state, not an event.

Safety Filter Evasion: You must strictly avoid violent trigger words like "explode," "kill," "destroy," "incinerate," or "blast." Instead, use sanitized, epic vocabulary like "display of light," "radiant force," "sustained energy," "surge," and "continuous stream."

JSON Keys & Grammatical Handshakes:
1. build_up_description: Describe the simultaneous release of energy/force from both the foreground character and the background adversary. Crucially, you must describe these forces traveling across the vertical space and meeting perfectly in the dead center.
2. collision_description: Describe the exact moment of impact not as a fading explosion, but as the immediate formation of a permanent, massive, frozen visual anchor. State that it reaches its maximum size instantly.

User Fantasy: ${fantasyPrompt}
        `;

        const base64DataGenB = generatedImageUrlB.split(',')[1];
        const mimeTypeGenB = generatedImageUrlB.split(';')[0].split(':')[1];

        const planResponseBuildUp = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-pro-preview',
          contents: {
            parts: [
              { inlineData: { data: base64DataGenA, mimeType: mimeTypeGenA } },
              { inlineData: { data: base64DataGenB, mimeType: mimeTypeGenB } },
              { text: plannerPromptBuildUp },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                build_up_description: { type: Type.STRING },
                collision_description: { type: Type.STRING }
              },
              required: ['build_up_description', 'collision_description']
            }
          }
        });

        const planBuildUp = JSON.parse(planResponseBuildUp.text || '{}');

        const videoPromptBuildUp = `
- The main character in the close-up foreground swiftly turns the head and body away from the camera to face the distant background.
- ${planBuildUp.build_up_description}
- ${planBuildUp.collision_description}, which remains perfectly balanced, completely locked in a static, unchanging, and perfectly sustained state for the remainder of the video, and does not fade, shift, or dissipate
        `;

        let operationBuildUp = await generateVideosWithRetry(ai, {
          model: 'veo-3.1-fast-generate-preview',
          prompt: videoPromptBuildUp,
          image: { imageBytes: base64DataGenA, mimeType: mimeTypeGenA },
          config: {
            numberOfVideos: 1,
            resolution: '720p',
            lastFrame: { imageBytes: base64DataGenB, mimeType: mimeTypeGenB },
            aspectRatio: '9:16'
          }
        });

        while (!operationBuildUp.done) {
          if (!isMounted) return;
          await new Promise(resolve => setTimeout(resolve, 10000));
          operationBuildUp = await ai.operations.getVideosOperation({operation: operationBuildUp});
        }

        const buildUpLink = operationBuildUp.response?.generatedVideos?.[0]?.video?.uri;
        let buildUpUrl = null;
        if (buildUpLink) {
          const res = await fetch(buildUpLink, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' } });
          const blob = await res.blob();
          buildUpUrl = URL.createObjectURL(blob);
        } else {
          throw new Error("Failed to generate Build Up Video.");
        }

        // 4. Main QTE Video
        setGenerationStatus('Generating Main QTE Video...');
        const plannerPromptQTE = `
You are the Master Video Looping Director for a dynamic AI video generation engine. Your job is to analyze a user's raw fantasy scenario and translate the peak tension of their conflict into four highly vivid, static descriptions formatted strictly as a JSON object.

Your absolute primary goal is to describe an Infinite Loop. You must trap the scene in a permanent, unyielding stalemate where nothing moves forward and nothing fades away.

Safety Filter Evasion: You must avoid words implying destruction or resolution (e.g., "exploding," "crushing," "burning down"). Use words implying sustained equilibrium (e.g., "radiating," "sustaining," "vibrating," "locked").

JSON Keys & Grammatical Handshakes:
1. clash_phenomenon: Provide a noun-phrase summarizing the two opposing forces that are meeting.
2. central_anchor_description: Describe the visual mass of the collision point. What does the center look like?
3. particle_effects: Describe the localized, swirling ambient effects happening around the center point. This gives the video internal motion so it looks alive while looping. Start with a capitalized noun.
4. character_poses: Describe how the two entities are physically locked in exertion. How are they holding their ground?

User Fantasy: ${fantasyPrompt}
        `;

        const buildUpRes = await fetch(buildUpUrl);
        const buildUpBlob = await buildUpRes.blob();
        const buildUpBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(buildUpBlob);
        });

        const planResponseQTE = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-pro-preview',
          contents: {
            parts: [
              { inlineData: { data: buildUpBase64, mimeType: 'video/mp4' } },
              { text: plannerPromptQTE },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                clash_phenomenon: { type: Type.STRING },
                central_anchor_description: { type: Type.STRING },
                particle_effects: { type: Type.STRING },
                character_poses: { type: Type.STRING }
              },
              required: ['clash_phenomenon', 'central_anchor_description', 'particle_effects', 'character_poses']
            }
          }
        });

        const planQTE = JSON.parse(planResponseQTE.text || '{}');

        const videoPromptQTE = `
- ${planQTE.clash_phenomenon} continues in a state of perfect, unyielding balance. 
- ${planQTE.central_anchor_description} in the center of the vertical frame remains at its absolute maximum size and intensity. 
- The physical forces do not dissipate, fade, or move; they are locked in a constant, perfectly sustained state. 
- ${planQTE.particle_effects}, but the core stays colossal and unmoving. 
- The main character in the foreground (seen completely from behind) and the adversary in the distant background ${planQTE.character_poses}, trapped in a continuous, unchanging stalemate.
        `;

        const lastFrameBuildUpBase64 = await extractLastFrame(buildUpUrl);

        let operationQTE = await generateVideosWithRetry(ai, {
          model: 'veo-3.1-fast-generate-preview',
          prompt: videoPromptQTE,
          image: { imageBytes: lastFrameBuildUpBase64, mimeType: 'image/jpeg' },
          config: {
            numberOfVideos: 1,
            resolution: '720p',
            aspectRatio: '9:16'
          }
        });

        while (!operationQTE.done) {
          if (!isMounted) return;
          await new Promise(resolve => setTimeout(resolve, 10000));
          operationQTE = await ai.operations.getVideosOperation({operation: operationQTE});
        }

        const qteLink = operationQTE.response?.generatedVideos?.[0]?.video?.uri;
        let qteUrl = null;
        if (qteLink) {
          const res = await fetch(qteLink, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' } });
          const blob = await res.blob();
          qteUrl = URL.createObjectURL(blob);
        } else {
          throw new Error("Failed to generate QTE Video.");
        }

        // 5. Win Video
        setGenerationStatus('Generating Win Video...');
        const plannerPromptWin = `
You are the Master Resolution Director for a dynamic AI video generation engine. Your job is to analyze a user's raw fantasy scenario and translate the player's victorious climax into four highly vivid, kinetically forward-moving descriptions formatted strictly as a JSON object.

Your goal is to describe the moment the player's avatar breaks the stalemate, pushes their energy/force deep into the background, and spectacularly overcomes the adversary.

Forward Kinetic Momentum: The entire visual flow of this video must move away from the camera and deep into the background. The central collision point must rapidly travel away from the viewer.
Safety Filter Evasion (CRITICAL): Do not use any words associated with violent death, gore, or brutal destruction (e.g., "incinerates," "crushes," "blows up," "kills," "destroys"). You must describe the adversary's defeat as being "swept away," "enveloped," "dissolved into light/particles," or "overwhelmed by force."

JSON Keys & Grammatical Handshakes:
1. hero_surge: Describe the final, massive exertion of effort from the player's avatar that breaks the tie.
2. central_mass: Describe the visual mass of the collision point that is now being pushed away from the camera.
3. hero_energy: Name the specific visual element of the hero's power that is washing over the opponent.
4. impact_resolution: Describe the nature of the final sweeping force that clears the screen of the enemy safely and cinematically.

User Fantasy: ${fantasyPrompt}
        `;

        const qteRes = await fetch(qteUrl);
        const qteBlob = await qteRes.blob();
        const qteBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(qteBlob);
        });

        const planResponseWin = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-pro-preview',
          contents: {
            parts: [
              { inlineData: { data: qteBase64, mimeType: 'video/mp4' } },
              { text: plannerPromptWin },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                hero_surge: { type: Type.STRING },
                central_mass: { type: Type.STRING },
                hero_energy: { type: Type.STRING },
                impact_resolution: { type: Type.STRING }
              },
              required: ['hero_surge', 'central_mass', 'hero_energy', 'impact_resolution']
            }
          }
        });

        const planWin = JSON.parse(planResponseWin.text || '{}');

        const videoPromptWin = `
- The perfectly balanced stalemate shifts as the main character in the foreground ${planWin.hero_surge}. 
- The ${planWin.central_mass} rapidly pushes forward, moving deep into the background and completely overpowering the adversary's force. 
- The ${planWin.hero_energy} sweeps over and completely engulfs the adversary, enveloping them in a massive, radiant burst. 
- The sheer force of the ${planWin.impact_resolution} sweeps the adversary backward and out of view in a majestic, overwhelming flash, leaving the main character standing victorious.
        `;

        const lastFrameQTEBase64 = await extractLastFrame(qteUrl);

        let operationWin = await generateVideosWithRetry(ai, {
          model: 'veo-3.1-fast-generate-preview',
          prompt: videoPromptWin,
          image: { imageBytes: lastFrameQTEBase64, mimeType: 'image/jpeg' },
          config: {
            numberOfVideos: 1,
            resolution: '720p',
            aspectRatio: '9:16'
          }
        });

        while (!operationWin.done) {
          if (!isMounted) return;
          await new Promise(resolve => setTimeout(resolve, 10000));
          operationWin = await ai.operations.getVideosOperation({operation: operationWin});
        }

        const winLink = operationWin.response?.generatedVideos?.[0]?.video?.uri;
        let winUrl = null;
        if (winLink) {
          const res = await fetch(winLink, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' } });
          const blob = await res.blob();
          winUrl = URL.createObjectURL(blob);
        } else {
          throw new Error("Failed to generate Win Video.");
        }

        // 6. Lose Video
        setGenerationStatus('Generating Lose Video...');
        const plannerPromptLose = `
You are the Master Resolution Director for a dynamic AI video generation engine. Your job is to analyze a user's raw fantasy scenario and translate the player's tragic defeat into four highly vivid, kinetically backward-moving descriptions formatted strictly as a JSON object.

Your goal is to describe the moment the adversary breaks the stalemate, pushes their energy/force rapidly toward the foreground, and spectacularly overcomes the player's avatar.

Backward Kinetic Momentum: The entire visual flow of this video must move toward the camera and deep into the foreground. The central collision point must rapidly travel toward the viewer.
Safety Filter Evasion (CRITICAL): Do not use any words associated with violent death, gore, or brutal destruction (e.g., "incinerates," "crushes," "blows up," "kills," "destroys"). You must describe the hero's defeat as being "swept away," "enveloped," "dissolved into light/particles," or "overwhelmed by force."

JSON Keys & Grammatical Handshakes:
1. adversary_surge: Describe the final, massive exertion of effort from the adversary that breaks the tie.
2. central_mass: Describe the visual mass of the collision point that is now being pushed toward the camera.
3. adversary_energy: Name the specific visual element of the adversary's power that is washing over the hero.
4. impact_resolution: Describe the nature of the final sweeping force that clears the screen of the hero safely and cinematically.

User Fantasy: ${fantasyPrompt}
        `;

        const planResponseLose = await generateContentWithRetry(ai, {
          model: 'gemini-3.1-pro-preview',
          contents: {
            parts: [
              { inlineData: { data: qteBase64, mimeType: 'video/mp4' } },
              { text: plannerPromptLose },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                adversary_surge: { type: Type.STRING },
                central_mass: { type: Type.STRING },
                adversary_energy: { type: Type.STRING },
                impact_resolution: { type: Type.STRING }
              },
              required: ['adversary_surge', 'central_mass', 'adversary_energy', 'impact_resolution']
            }
          }
        });

        const planLose = JSON.parse(planResponseLose.text || '{}');

        const videoPromptLose = `
- The perfectly balanced stalemate shifts as the adversary in the background ${planLose.adversary_surge}. 
- The ${planLose.central_mass} rapidly pushes backward, moving deep into the foreground and completely overpowering the main character's force. 
- The ${planLose.adversary_energy} sweeps over and completely engulfs the main character, enveloping them in a massive, radiant burst. 
- The sheer force of the ${planLose.impact_resolution} sweeps the main character backward and out of view in a majestic, overwhelming flash, leaving the adversary standing victorious.
        `;

        let operationLose = await generateVideosWithRetry(ai, {
          model: 'veo-3.1-fast-generate-preview',
          prompt: videoPromptLose,
          image: { imageBytes: lastFrameQTEBase64, mimeType: 'image/jpeg' },
          config: {
            numberOfVideos: 1,
            resolution: '720p',
            aspectRatio: '9:16'
          }
        });

        while (!operationLose.done) {
          if (!isMounted) return;
          await new Promise(resolve => setTimeout(resolve, 10000));
          operationLose = await ai.operations.getVideosOperation({operation: operationLose});
        }

        const loseLink = operationLose.response?.generatedVideos?.[0]?.video?.uri;
        let loseUrl = null;
        if (loseLink) {
          const res = await fetch(loseLink, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' } });
          const blob = await res.blob();
          loseUrl = URL.createObjectURL(blob);
        } else {
          throw new Error("Failed to generate Lose Video.");
        }

        if (isMounted) {
          setVideos({
            buildup: buildUpUrl,
            main: qteUrl,
            win: winUrl,
            lose: loseUrl
          });
          setPhase('idle');
        }

      } catch (err: any) {
        if (isMounted) {
          console.error("QTE Generation Error:", err);
          setGenerationError(err.message || "An error occurred during QTE generation.");
        }
      }
    };

    generateAllAssets();

    return () => {
      isMounted = false;
    };
  }, [profile]);

  const [hasWon, setHasWon] = useState(false);

  const [buildupVideo, setBuildupVideo] = useState<HTMLVideoElement | null>(null);
  const [mainVideo, setMainVideo] = useState<HTMLVideoElement | null>(null);
  const [winVideo, setWinVideo] = useState<HTMLVideoElement | null>(null);
  const [loseVideo, setLoseVideo] = useState<HTMLVideoElement | null>(null);

  const startGame = () => {
    if (buildupVideo) {
      [mainVideo, winVideo, loseVideo].forEach(v => {
        if (v) {
          v.dataset.playingForReal = 'false';
          const playPromise = v.play();
          if (playPromise !== undefined) {
            playPromise.then(() => {
              if (v.dataset.playingForReal !== 'true') {
                v.pause();
                v.currentTime = 0;
              }
            }).catch(() => {});
          }
        }
      });

      buildupVideo.dataset.playingForReal = 'true';
      buildupVideo.currentTime = 0;
      buildupVideo.play().catch(e => console.error("Playback failed:", e));
      setHasWon(false);
      setPhase('playing_buildup');
    }
  };

  const resetGame = () => {
    [buildupVideo, mainVideo, winVideo, loseVideo].forEach(v => {
      if (v) {
        v.dataset.playingForReal = 'false';
        v.pause();
        v.currentTime = 0;
      }
    });
    setPhase('idle');
  };

  const handleBuildupEnded = () => {
    if (mainVideo) {
      mainVideo.dataset.playingForReal = 'true';
      mainVideo.currentTime = 0;
      mainVideo.play();
      setPhase('playing_main');
    }
  };

  const handleMainEnded = () => {
    if (hasWon && winVideo) {
      winVideo.dataset.playingForReal = 'true';
      winVideo.currentTime = 0;
      winVideo.play();
      setPhase('playing_win');
    } else if (!hasWon && loseVideo) {
      loseVideo.dataset.playingForReal = 'true';
      loseVideo.currentTime = 0;
      loseVideo.play();
      setPhase('playing_lose');
    } else {
      setPhase('ended');
    }
  };

  const handleCinematicEnded = () => {
    setPhase('ended');
  };

  const activeVideo = phase === 'idle' || phase === 'playing_buildup' ? buildupVideo :
                      phase === 'playing_main' ? mainVideo :
                      phase === 'playing_win' ? winVideo :
                      phase === 'playing_lose' ? loseVideo : null;

  const isPlaying = phase.startsWith('playing');

  return (
    <div className="w-full h-full bg-zinc-950 text-white flex flex-col font-sans overflow-hidden absolute inset-0 z-50">
      <div className="fixed inset-0 w-full h-full opacity-0 pointer-events-none z-[-1]">
        <video ref={setBuildupVideo} src={videos.buildup || undefined} preload="auto" playsInline onEnded={handleBuildupEnded} />
        <video ref={setMainVideo} src={videos.main || undefined} preload="auto" playsInline onEnded={handleMainEnded} />
        <video ref={setWinVideo} src={videos.win || undefined} preload="auto" playsInline onEnded={handleCinematicEnded} />
        <video ref={setLoseVideo} src={videos.lose || undefined} preload="auto" playsInline onEnded={handleCinematicEnded} />
      </div>

      {phase === 'setup' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <div className="max-w-md w-full bg-zinc-900/80 backdrop-blur-xl rounded-3xl border border-white/10 shadow-2xl p-8 text-center">
            <h2 className="text-2xl font-bold mb-6 text-cyan-400">Final Boss Encounter</h2>
            
            {generationError ? (
              <div className="p-4 bg-red-500/20 border border-red-500/50 rounded-xl text-red-200 text-sm">
                {generationError}
                <button 
                  onClick={onComplete}
                  className="mt-4 px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-colors"
                >
                  Skip Final Boss
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="w-12 h-12 border-4 border-zinc-700 border-t-cyan-500 rounded-full animate-spin mb-6" />
                <p className="text-zinc-300 font-medium">{generationStatus}</p>
                <p className="text-zinc-500 text-sm mt-2">This will take a few minutes. Prepare yourself.</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="relative flex-1 w-full h-full flex items-center justify-center bg-black overflow-hidden">
          <div 
            className="relative w-full h-full bg-zinc-950 overflow-hidden shadow-2xl touch-none"
            style={{
              maxWidth: 'calc(100vh * (9/16))',
              maxHeight: 'calc(100vw * (16/9))',
              aspectRatio: '9/16',
              touchAction: 'none'
            }}
          >
            <header className="absolute top-0 left-0 w-full p-6 z-20 flex justify-between items-center pointer-events-none">
              <h1 className="text-2xl font-bold tracking-tight text-white drop-shadow-md">
                FINAL <span className="text-cyan-400">BOSS</span>
              </h1>
              {phase === 'playing_main' && activeVideo && (
                <div className="absolute left-1/2 -translate-x-1/2 w-1/2 max-w-md">
                  <ProgressBar video={activeVideo} isPlaying={isPlaying} />
                </div>
              )}
            </header>

            <Canvas camera={{ position: [0, 0, 5], fov: 75 }}>
              <ambientLight intensity={1} />
              <React.Suspense fallback={null}>
                <VideoBackground video={buildupVideo} visible={phase === 'idle' || phase === 'playing_buildup'} />
                <VideoBackground video={mainVideo} visible={phase === 'playing_main'} />
                <VideoBackground video={winVideo} visible={phase === 'playing_win'} />
                <VideoBackground video={loseVideo} visible={phase === 'playing_lose'} />
              </React.Suspense>
              <DrawingQTE video={mainVideo} phase={phase} hasWon={hasWon} onWin={() => setHasWon(true)} />
              <ResultOverlay phase={phase} hasWon={hasWon} />
            </Canvas>

            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-black/60 backdrop-blur-md px-6 py-3 rounded-full border border-white/10 z-10">
              {phase === 'idle' && (
                <button 
                  onClick={startGame}
                  className="w-12 h-12 flex items-center justify-center bg-white text-black rounded-full hover:scale-105 active:scale-95 transition-transform"
                >
                  <Play className="w-5 h-5 fill-current ml-1" />
                </button>
              )}
              {phase === 'ended' && (
                <>
                  {!hasWon && (
                    <button 
                      onClick={resetGame}
                      className="px-6 h-12 flex items-center justify-center bg-zinc-800 text-white font-bold rounded-full hover:scale-105 active:scale-95 transition-transform"
                    >
                      TRY AGAIN
                    </button>
                  )}
                  <button 
                    onClick={onComplete}
                    className="px-6 h-12 flex items-center justify-center bg-white text-black font-bold rounded-full hover:scale-105 active:scale-95 transition-transform"
                  >
                    FINISH MISSION
                  </button>
                </>
              )}
            </div>
            
            {phase === 'idle' && buildupVideo && (
              <div 
                className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm z-30 cursor-pointer"
                onClick={startGame}
              >
                <div className="text-center">
                  <Play className="w-20 h-20 text-white/50 mx-auto mb-4" />
                  <p className="text-2xl font-medium text-white tracking-wide">Tap Anywhere to Start</p>
                  <p className="text-zinc-300 mt-2">Draw the 3 patterns before the video ends!</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
