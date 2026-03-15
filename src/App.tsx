import { useEffect, useState } from 'react';
import Forge from './components/Forge';
import Armory from './components/Armory';
import Scouting from './components/Scouting';
import Battlefield from './components/Battlefield';
import { LoreProfile } from './types';
import { auth, googleProvider } from './firebase';
import { onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword, signInAnonymously, User } from 'firebase/auth';

/**
 * App Component
 * 
 * The root component of the Dreamie application. It manages the high-level state
 * including API key verification and top-level navigation between the main views:
 * - Armory: The main dashboard where users select a profile to play.
 * - Forge: The profile creation screen where users generate their fantasy avatar.
 * - Scouting: The planning phase where users map real-world chores to fantasy actions.
 * - Battlefield: The execution phase where users perform chores and see the story unfold.
 */
export default function App() {
  // State to track if the user has provided a valid Gemini API key
  const [hasKey, setHasKey] = useState<boolean>(false);
  // State to handle the initial loading state while checking for the API key
  const [loading, setLoading] = useState<boolean>(true);
  // State to manage the current active view in the application
  const [currentView, setCurrentView] = useState<'forge' | 'armory' | 'scouting' | 'battlefield'>('armory');
  // State to store the currently selected LoreProfile for the quest
  const [selectedProfile, setSelectedProfile] = useState<LoreProfile | null>(null);
  // State to store the ID of the active quest being played
  const [activeQuestId, setActiveQuestId] = useState<string | null>(null);
  // Firebase Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  /**
   * Effect hook to check if the user has already selected an API key.
   * This is required for accessing the Gemini API.
   */
  useEffect(() => {
    const checkKey = async () => {
      try {
        // @ts-ignore
        const hasSelected = await window.aistudio.hasSelectedApiKey();
        setHasKey(hasSelected);
      } catch (e) {
        console.error("Failed to check API key", e);
      } finally {
        setLoading(false);
      }
    };
    checkKey();
  }, []);

  /**
   * Handler to open the API key selection dialog.
   * Mitigates race conditions by assuming success immediately after the dialog interaction.
   */
  const handleSelectKey = async () => {
    try {
      // @ts-ignore
      await window.aistudio.openSelectKey();
      // Assume success to mitigate race condition
      setHasKey(true);
    } catch (e) {
      console.error("Failed to select API key", e);
    }
  };

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      console.error("Email login failed", error);
      setLoginError(error.message || "Failed to login. Please check your credentials.");
    }
  };

  const handleGuestLogin = async () => {
    setLoginError(null);
    try {
      await signInAnonymously(auth);
    } catch (error: any) {
      console.error("Guest login failed", error);
      setLoginError(error.message || "Failed to login as guest.");
    }
  };

  /**
   * Handler to start a new quest with a selected profile.
   * Transitions the view to the 'scouting' phase.
   * 
   * @param profile The LoreProfile selected by the user.
   */
  const handleStartQuest = (profile: LoreProfile) => {
    setSelectedProfile(profile);
    setCurrentView('scouting');
  };

  // Render a loading screen while checking for the API key
  if (loading || authLoading) {
    return <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-6">
        <h1 className="text-4xl font-bold mb-4 text-emerald-400">Project Dreamie</h1>
        <p className="text-zinc-400 mb-8 max-w-md text-center">
          Login to save your epic avatars and cinematic quests to the cloud.
        </p>
        
        <form onSubmit={handleEmailLogin} className="w-full max-w-sm flex flex-col gap-4 mb-6">
          <input 
            type="email" 
            placeholder="Email (e.g. judge@example.com)" 
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500"
            required
          />
          <input 
            type="password" 
            placeholder="Password" 
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500"
            required
          />
          {loginError && <p className="text-red-400 text-sm">{loginError}</p>}
          <button
            type="submit"
            className="bg-emerald-500 hover:bg-emerald-600 text-zinc-950 font-bold py-3 px-8 rounded-xl transition-colors"
          >
            Login with Email
          </button>
        </form>

        <div className="flex items-center gap-4 w-full max-w-sm mb-6">
          <div className="flex-1 h-px bg-zinc-800"></div>
          <span className="text-zinc-500 text-sm">OR</span>
          <div className="flex-1 h-px bg-zinc-800"></div>
        </div>

        <button
          onClick={handleLogin}
          className="bg-white hover:bg-zinc-200 text-zinc-950 font-bold py-3 px-8 rounded-xl transition-colors w-full max-w-sm flex items-center justify-center gap-2 mb-4"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Login with Google
        </button>

        <button
          onClick={handleGuestLogin}
          className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-bold py-3 px-8 rounded-xl transition-colors w-full max-w-sm flex items-center justify-center gap-2"
        >
          Enter as Guest
        </button>
      </div>
    );
  }

  // Render the API key connection screen if no key is found
  if (!hasKey) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-6">
        <h1 className="text-4xl font-bold mb-4 text-emerald-400">Project Dreamie</h1>
        <p className="text-zinc-400 mb-8 max-w-md text-center">
          To generate your epic avatar and cinematic finales, you need to connect your Google Cloud API key with billing enabled.
        </p>
        <button
          onClick={handleSelectKey}
          className="bg-emerald-500 hover:bg-emerald-600 text-zinc-950 font-bold py-3 px-8 rounded-full transition-colors"
        >
          Connect API Key
        </button>
        <a 
          href="https://ai.google.dev/gemini-api/docs/billing" 
          target="_blank" 
          rel="noreferrer"
          className="mt-4 text-sm text-zinc-500 hover:text-zinc-300 underline"
        >
          Learn about billing
        </a>
      </div>
    );
  }

  // Main application render, switching between views based on currentView state
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      {currentView === 'armory' && (
        <Armory 
          onNavigate={() => setCurrentView('forge')} 
          onStartQuest={handleStartQuest}
        />
      )}
      {currentView === 'forge' && (
        <Forge onNavigate={() => setCurrentView('armory')} />
      )}
      {currentView === 'scouting' && selectedProfile && (
        <Scouting 
          profile={selectedProfile} 
          onBack={() => setCurrentView('armory')}
          onEngage={(questId) => {
            console.log("Engage quest:", questId);
            setActiveQuestId(questId);
            setCurrentView('battlefield');
          }}
        />
      )}
      {currentView === 'battlefield' && selectedProfile && activeQuestId && (
        <Battlefield 
          profile={selectedProfile}
          questId={activeQuestId}
          onComplete={() => setCurrentView('armory')}
        />
      )}
    </div>
  );
}
