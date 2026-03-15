import { useEffect, useState } from 'react';
import { LoreProfile } from '../types';
import { Plus, Play, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';

interface ArmoryProps {
  onNavigate: () => void;
  onStartQuest: (profile: LoreProfile) => void;
}

/**
 * Armory Component
 * 
 * The main dashboard where users can view their created "Lore Profiles" (fantasy avatars).
 * It fetches the profiles from the backend and displays them in a horizontal scrolling list.
 * Users can either select a profile to start a quest or navigate to the Forge to create a new one.
 */
export default function Armory({ onNavigate, onStartQuest }: ArmoryProps) {
  // State to hold the list of user-created Lore Profiles
  const [profiles, setProfiles] = useState<LoreProfile[]>([]);
  // State to manage the loading indicator while fetching profiles
  const [loading, setLoading] = useState(true);
  // State to track which profile is currently centered in the horizontal scroll view
  const [activeIndex, setActiveIndex] = useState(0);

  /**
   * Effect hook to fetch the user's Lore Profiles from the backend API on component mount.
   */
  useEffect(() => {
    const fetchProfiles = async () => {
      try {
        const { auth, db } = await import('../firebase');
        const { collection, getDocs, query, orderBy } = await import('firebase/firestore');
        
        const user = auth.currentUser;
        if (!user) return;

        const q = query(collection(db, 'users', user.uid, 'profiles'), orderBy('createdAt', 'desc'));
        const querySnapshot = await getDocs(q);
        
        const fetchedProfiles: LoreProfile[] = [];
        querySnapshot.forEach((doc) => {
          fetchedProfiles.push({ id: doc.id as any, ...doc.data() } as LoreProfile);
        });
        
        setProfiles(fetchedProfiles);
      } catch (e) {
        console.error("Failed to fetch profiles", e);
      } finally {
        setLoading(false);
      }
    };
    fetchProfiles();
  }, []);

  /**
   * Deletes a specific Lore Profile from the Firestore database and updates the local state.
   * 
   * @param profileId - The unique identifier of the profile to be deleted.
   */
  const handleDeleteProfile = async (profileId: string) => {
    try {
      const { auth, db } = await import('../firebase');
      const { doc, deleteDoc } = await import('firebase/firestore');
      const user = auth.currentUser;
      if (!user) return;

      // Delete the document from the user's 'profiles' subcollection in Firestore
      await deleteDoc(doc(db, 'users', user.uid, 'profiles', profileId));
      
      // Update local state to remove the deleted profile from the UI
      setProfiles(prev => prev.filter(p => p.id !== profileId));
      
      // Adjust the active index if the deleted profile was the last one in the list
      if (activeIndex >= profiles.length - 1) {
        setActiveIndex(Math.max(0, profiles.length - 2));
      }
    } catch (e) {
      console.error("Failed to delete profile", e);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen flex flex-col p-6 max-w-md mx-auto relative"
    >
      {/* Header section with title and button to create a new profile */}
      <header className="flex justify-between items-center mb-8 pt-8">
        <h1 className="text-3xl font-bold tracking-tight text-emerald-400">The Armory</h1>
        <button 
          onClick={onNavigate}
          className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 transition-colors"
        >
          <Plus className="w-6 h-6 text-zinc-300" />
        </button>
      </header>

      {/* Conditional rendering based on loading state and profile availability */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-zinc-500">Loading your legends...</div>
        </div>
      ) : profiles.length === 0 ? (
        // Empty state when no profiles exist
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-24 h-24 bg-zinc-800 rounded-full flex items-center justify-center mb-6">
            <Plus className="w-10 h-10 text-zinc-600" />
          </div>
          <h2 className="text-xl font-semibold mb-2 text-zinc-200">No Legends Forged</h2>
          <p className="text-zinc-500 mb-8">Create your first Lore Profile to begin your epic quest.</p>
          <button 
            onClick={onNavigate}
            className="bg-emerald-500 hover:bg-emerald-600 text-zinc-950 font-bold py-3 px-8 rounded-full transition-colors"
          >
            Forge a Legend
          </button>
        </div>
      ) : (
        // List of profiles displayed in a horizontal snap-scrolling container
        <div className="flex-1 flex flex-col">
          <div className="flex overflow-x-auto snap-x snap-mandatory gap-6 pb-8 hide-scrollbar" onScroll={(e) => {
            // Calculate the currently active index based on scroll position
            const container = e.currentTarget;
            const scrollPosition = container.scrollLeft;
            const itemWidth = container.clientWidth * 0.85 + 24; // 85% width + 24px gap
            const newIndex = Math.round(scrollPosition / itemWidth);
            setActiveIndex(newIndex);
          }}>
            {profiles.map((profile, index) => (
              <div 
                key={profile.id} 
                // Apply a dynamic border and shadow highlight if this profile is the currently active (centered) one
                className={`snap-center shrink-0 w-[85%] bg-zinc-900 rounded-3xl overflow-hidden border shadow-xl flex flex-col relative transition-all duration-300 ${
                  index === activeIndex ? 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]' : 'border-zinc-800'
                }`}
              >
                {/* Delete Button: Allows users to remove this specific Lore Profile */}
                <button
                  onClick={(e) => {
                    e.stopPropagation(); // Prevent triggering any parent click events
                    if (profile.id) handleDeleteProfile(profile.id);
                  }}
                  className="absolute top-4 right-4 p-2 bg-black/50 hover:bg-red-500/80 rounded-full transition-colors z-10"
                  aria-label="Delete profile"
                >
                  <Trash2 className="w-5 h-5 text-white" />
                </button>

                {/* Profile Image and Header Info */}
                <div className="h-64 relative bg-zinc-800">
                  {profile.avatar_url ? (
                    <img 
                      src={profile.avatar_url} 
                      alt={profile.character_role} 
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-600">
                      No Avatar
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-zinc-900 via-transparent to-transparent" />
                  <div className="absolute bottom-4 left-4 right-4">
                    <h3 className="text-2xl font-bold text-white">{profile.character_role}</h3>
                    <p className="text-emerald-400 text-sm font-medium">{profile.genre}</p>
                  </div>
                </div>
                {/* Profile Details */}
                <div className="p-5 flex-1 flex flex-col gap-3">
                  <div>
                    <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Enemies</span>
                    <p className="text-zinc-300 text-sm">{profile.primary_enemies}</p>
                  </div>
                  <div>
                    <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Motivation</span>
                    <p className="text-zinc-300 text-sm line-clamp-2">{profile.core_motivation}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Action button to start a quest with the currently active profile */}
          <div className="mt-auto pb-8">
            <button 
              onClick={() => onStartQuest(profiles[activeIndex])}
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all active:scale-95"
            >
              <Play className="w-5 h-5 fill-current" />
              Embark on a Quest
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
