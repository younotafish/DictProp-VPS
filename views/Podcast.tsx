import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Headphones, 
  Play, 
  Pause, 
  Loader2, 
  ChevronDown, 
  ChevronUp, 
  Search, 
  X,
  Plus,
  Wand2,
  Clock,
  Radio,
  FileText,
  AlertCircle,
  Trash2,
  RefreshCw,
  Zap,
  ArrowDownAZ,
  TrendingDown,
  History,
} from 'lucide-react';
import { StoredItem, PodcastMetadata, AppUser, VocabCard, isVocabItem, getItemSpelling } from '../types';
import { subscribeToPodcasts, getPodcastAudioUrl } from '../services/firebase';
import { generatePodcast, deletePodcast as deletePodcastService, retryPodcast as retryPodcastService } from '../services/podcastService';

interface PodcastViewProps {
  user: AppUser | null;
  isOnline: boolean;
  items: StoredItem[];
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  podcastQueue?: string[]; // Item IDs queued from review
  onAddToQueue?: (ids: string[]) => void;
  onRemoveFromQueue?: (id: string) => void;
  onClearQueue?: () => void;
}

// Format duration in seconds to MM:SS
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format relative date
function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  
  return new Date(timestamp).toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: days > 365 ? 'numeric' : undefined 
  });
}

// ============================================================================
// Audio Player Component (with speed control, resume position, currentTime callback)
// ============================================================================

const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2];

const AudioPlayer: React.FC<{
  audioPath: string;
  duration: number;
  podcastId: string;
  onTimeUpdate?: (time: number) => void;
}> = ({ audioPath, duration, podcastId, onTimeUpdate: onTimeUpdateCb }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Playback speed — persisted globally
  const [speed, setSpeed] = useState(() => parseFloat(localStorage.getItem('podcast_speed') || '1'));

  // Resume position — debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const posKey = `podcast_pos_${podcastId}`;

  const cycleSpeed = () => {
    const idx = PLAYBACK_SPEEDS.indexOf(speed);
    const next = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    setSpeed(next);
    localStorage.setItem('podcast_speed', String(next));
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  // Load audio URL on first play
  const loadAndPlay = async () => {
    if (!audioUrl) {
      setLoading(true);
      setError(null);
      try {
        const url = await getPodcastAudioUrl(audioPath);
        setAudioUrl(url);
        // Audio will auto-play via onCanPlay handler
      } catch (err: any) {
        setError(err?.message || 'Failed to load audio. Please check your connection and try again.');
        setLoading(false);
        return;
      }
    } else {
      togglePlayback();
    }
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((e) => setError('Tap play to start — your browser blocked autoplay.'));
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = parseFloat(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
    onTimeUpdateCb?.(time);
  };

  // Save position to localStorage (debounced)
  const savePosition = useCallback((time: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try { localStorage.setItem(posKey, String(time)); } catch {}
    }, 2000);
  }, [posKey]);

  // Cleanup save timer
  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  return (
    <div className="space-y-3">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onCanPlay={() => {
            setLoading(false);
            if (audioRef.current) {
              setAudioDuration(audioRef.current.duration || duration);
              audioRef.current.playbackRate = speed;
              // Restore saved position
              try {
                const saved = localStorage.getItem(posKey);
                if (saved) {
                  const pos = parseFloat(saved);
                  if (pos > 0 && pos < (audioRef.current.duration || duration) - 5) {
                    audioRef.current.currentTime = pos;
                    setCurrentTime(pos);
                  }
                }
              } catch {}
              // Auto-play after loading
              audioRef.current.play().catch((e) => {
                // On mobile, autoplay may be blocked — show play button instead of error
                setIsPlaying(false);
              });
            }
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => {
            const t = audioRef.current?.currentTime || 0;
            setCurrentTime(t);
            onTimeUpdateCb?.(t);
            savePosition(t);
          }}
          onEnded={() => {
            setIsPlaying(false);
            setCurrentTime(0);
            onTimeUpdateCb?.(0);
            // Clear saved position when finished
            try { localStorage.removeItem(posKey); } catch {}
          }}
          onError={() => { setError('Audio playback error'); setLoading(false); }}
        />
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={loadAndPlay}
          disabled={loading}
          className="w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center transition-colors shrink-0 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 size={20} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={20} />
          ) : (
            <Play size={20} className="ml-0.5" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <input
            type="range"
            min={0}
            max={audioDuration || duration}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-indigo-600"
          />
          <div className="flex justify-between mt-1">
            <span className="text-xs text-slate-400 font-mono">{formatDuration(Math.floor(currentTime))}</span>
            <span className="text-xs text-slate-400 font-mono">{formatDuration(Math.floor(audioDuration || duration))}</span>
          </div>
        </div>

        {/* Speed control */}
        <button
          onClick={cycleSpeed}
          className="h-8 px-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-600 transition-colors shrink-0"
          title="Playback speed"
        >
          {speed}x
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-500 flex items-center gap-1">
          <AlertCircle size={12} />
          {error}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Word Picker — adds words to the podcast queue (deduplicated by spelling)
// ============================================================================

interface WordGroup {
  word: string;
  chinese: string;
  itemIds: string[]; // All item IDs for this word (multiple senses)
  lowestStrength: number;
}

type SortMode = 'weakest' | 'az' | 'recent';

const WordAdder: React.FC<{
  items: StoredItem[];
  queuedIds: string[];
  onAddToQueue: (ids: string[]) => void;
}> = ({ items, queuedIds, onAddToQueue }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('weakest');

  // Group vocab items by word spelling, deduplicate
  const wordGroups = useMemo(() => {
    const vocabItems = items.filter(i => isVocabItem(i) && !i.isDeleted && !i.isArchived);
    const groupMap = new Map<string, WordGroup>();

    for (const item of vocabItems) {
      const spelling = getItemSpelling(item);
      if (!spelling) continue;
      const data = item.data as VocabCard;

      const existing = groupMap.get(spelling);
      if (existing) {
        existing.itemIds.push(item.data.id);
        const strength = item.srs?.memoryStrength ?? 100;
        if (strength < existing.lowestStrength) {
          existing.lowestStrength = strength;
        }
      } else {
        groupMap.set(spelling, {
          word: data.word,
          chinese: data.chinese,
          itemIds: [item.data.id],
          lowestStrength: item.srs?.memoryStrength ?? 100,
        });
      }
    }

    return Array.from(groupMap.values());
  }, [items]);

  // Filter by search, then sort
  const filteredGroups = useMemo(() => {
    let groups = [...wordGroups];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      groups = groups.filter(g =>
        g.word.toLowerCase().includes(q) ||
        g.chinese.toLowerCase().includes(q)
      );
    }

    // Sort
    switch (sortMode) {
      case 'weakest':
        groups.sort((a, b) => a.lowestStrength - b.lowestStrength);
        break;
      case 'az':
        groups.sort((a, b) => a.word.localeCompare(b.word));
        break;
      case 'recent':
        // Reverse of original order (newest items first — already insertion order)
        groups.reverse();
        break;
    }

    return groups;
  }, [wordGroups, searchQuery, sortMode]);

  const sortButtons: { mode: SortMode; icon: React.ReactNode; label: string }[] = [
    { mode: 'weakest', icon: <TrendingDown size={12} />, label: 'Weakest' },
    { mode: 'az', icon: <ArrowDownAZ size={12} />, label: 'A-Z' },
    { mode: 'recent', icon: <History size={12} />, label: 'Recent' },
  ];

  return (
    <div className="space-y-3">
      {/* Sort toggle */}
      <div className="flex gap-1 p-0.5 bg-slate-100 rounded-lg">
        {sortButtons.map(({ mode, icon, label }) => (
          <button
            key={mode}
            onClick={() => setSortMode(mode)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
              sortMode === mode
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search your vocabulary..."
          className="w-full pl-9 pr-8 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Word list */}
      <div className="max-h-60 overflow-y-auto rounded-xl border border-slate-100 divide-y divide-slate-50">
        {filteredGroups.length === 0 ? (
          <div className="p-4 text-center text-sm text-slate-400">
            {wordGroups.length === 0
              ? "No vocabulary items in your notebook yet."
              : "No matching words found."}
          </div>
        ) : (
          filteredGroups.map(group => {
            const allQueued = group.itemIds.every(id => queuedIds.includes(id));

            return (
              <div
                key={group.word}
                className={`flex items-center gap-3 px-3 py-2.5 ${allQueued ? 'bg-violet-50/50' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm text-slate-800">{group.word}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {group.chinese}
                    {group.itemIds.length > 1 && (
                      <span className="text-slate-400 ml-1">· {group.itemIds.length} senses</span>
                    )}
                  </div>
                </div>
                <div className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                  group.lowestStrength >= 80 ? 'bg-emerald-100 text-emerald-700' :
                  group.lowestStrength >= 50 ? 'bg-amber-100 text-amber-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {Math.round(group.lowestStrength)}%
                </div>
                {allQueued ? (
                  <span className="text-xs text-violet-500 font-medium shrink-0">Queued</span>
                ) : (
                  <button
                    onClick={() => onAddToQueue(group.itemIds)}
                    className="w-7 h-7 rounded-lg bg-violet-100 hover:bg-violet-200 text-violet-600 flex items-center justify-center transition-colors shrink-0"
                    title="Add to queue"
                  >
                    <Plus size={14} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Podcast Card Component (for history list)
// ============================================================================

const PodcastCard: React.FC<{
  podcast: PodcastMetadata;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDelete?: (id: string) => void;
  onRetry?: (id: string) => void;
}> = ({ podcast, isExpanded, onToggleExpand, onDelete, onRetry }) => {
  const [showScript, setShowScript] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Read-along state
  const [audioTime, setAudioTime] = useState(0);
  const scriptContainerRef = useRef<HTMLDivElement>(null);

  // Split script into paragraphs for read-along
  const paragraphs = useMemo(() => {
    if (!podcast.script) return [];
    return podcast.script.split(/\n\n+/).filter(p => p.trim());
  }, [podcast.script]);

  // Calculate cumulative word counts for paragraph time estimation
  const paragraphTimeRanges = useMemo(() => {
    if (paragraphs.length === 0 || !podcast.duration) return [];
    const totalWords = paragraphs.reduce((sum, p) => sum + p.split(/\s+/).length, 0);
    let cumWords = 0;
    return paragraphs.map(p => {
      const words = p.split(/\s+/).length;
      const start = (cumWords / totalWords) * podcast.duration;
      cumWords += words;
      const end = (cumWords / totalWords) * podcast.duration;
      return { start, end };
    });
  }, [paragraphs, podcast.duration]);

  // Current paragraph index based on audio time
  const currentParagraphIdx = useMemo(() => {
    if (!showScript || audioTime <= 0 || paragraphTimeRanges.length === 0) return -1;
    for (let i = paragraphTimeRanges.length - 1; i >= 0; i--) {
      if (audioTime >= paragraphTimeRanges[i].start) return i;
    }
    return 0;
  }, [audioTime, paragraphTimeRanges, showScript]);

  // Auto-scroll to current paragraph
  useEffect(() => {
    if (currentParagraphIdx < 0 || !scriptContainerRef.current) return;
    const el = scriptContainerRef.current.children[currentParagraphIdx] as HTMLElement;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentParagraphIdx]);

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    setActionError(null);
    try {
      await onDelete(podcast.id);
    } catch (err: any) {
      setActionError(err.message || 'Failed to delete');
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleRetry = async () => {
    if (!onRetry) return;
    setIsRetrying(true);
    setActionError(null);
    try {
      await onRetry(podcast.id);
    } catch (err: any) {
      setActionError(err.message || 'Failed to retry');
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      {/* Header */}
      <button 
        onClick={onToggleExpand}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
          podcast.status === 'generating' ? 'bg-violet-100 text-violet-600' :
          podcast.mode === 'daily' ? 'bg-violet-100 text-violet-600' : 'bg-indigo-100 text-indigo-600'
        }`}>
          {podcast.status === 'generating' ? (
            <Loader2 size={18} className="animate-spin" />
          ) : podcast.mode === 'daily' ? (
            <Radio size={18} />
          ) : (
            <Wand2 size={18} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-slate-800 flex items-center gap-2">
            {podcast.mode === 'daily' ? 'Daily Podcast' : 'Custom Podcast'}
            {podcast.status === 'generating' && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-600">Generating...</span>
            )}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <span>{formatRelativeDate(podcast.generatedAt)}</span>
            <span className="text-slate-300">·</span>
            <span>{podcast.wordCount} words</span>
            {podcast.status === 'ready' && podcast.duration > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="flex items-center gap-0.5">
                  <Clock size={10} />
                  ~{formatDuration(podcast.duration)}
                </span>
              </>
            )}
          </div>
        </div>
        {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-100 pt-3">
          {/* Generating state */}
          {podcast.status === 'generating' && (
            <div className="flex items-center gap-3 py-3 px-4 bg-violet-50 rounded-xl">
              <Loader2 size={18} className="animate-spin text-violet-600" />
              <div>
                <div className="text-sm font-medium text-violet-700">Generating podcast...</div>
                <div className="text-xs text-violet-500">This usually takes 2-5 minutes. You can leave and come back.</div>
              </div>
            </div>
          )}

          {/* Audio Player */}
          {podcast.status === 'ready' && (
            <AudioPlayer
              audioPath={podcast.audioPath}
              duration={podcast.duration}
              podcastId={podcast.id}
              onTimeUpdate={setAudioTime}
            />
          )}

          {/* Failed state with retry */}
          {podcast.status === 'failed' && (
            <div className="flex items-center gap-3 py-3 px-4 bg-red-50 rounded-xl">
              <AlertCircle size={18} className="text-red-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-red-700">Generation failed</div>
                <div className="text-xs text-red-500">An error occurred during podcast generation.</div>
              </div>
              {onRetry && (
                <button
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1 shrink-0 disabled:opacity-50"
                >
                  {isRetrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Retry
                </button>
              )}
            </div>
          )}

          {actionError && (
            <div className="text-xs text-red-500 flex items-center gap-1">
              <AlertCircle size={12} />
              {actionError}
            </div>
          )}

          {/* Word list */}
          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
              Words covered
            </div>
            <div className="flex flex-wrap gap-1.5">
              {podcast.words.map((w, i) => (
                <span key={i} className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded-lg">
                  {w.word}
                  <span className="text-slate-400 ml-1">{w.chinese}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Script toggle with read-along */}
          {podcast.script && (
            <div>
              <button
                onClick={() => setShowScript(!showScript)}
                className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                <FileText size={12} />
                {showScript ? 'Hide script' : 'Show script'}
                {showScript ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {showScript && (
                <div
                  ref={scriptContainerRef}
                  className="mt-2 p-3 bg-slate-50 rounded-xl text-sm text-slate-700 leading-relaxed max-h-60 overflow-y-auto"
                  style={{ scrollBehavior: 'smooth' }}
                >
                  {paragraphs.map((para, i) => (
                    <p
                      key={i}
                      className={`mb-3 last:mb-0 px-1 py-0.5 rounded transition-colors duration-300 ${
                        i === currentParagraphIdx
                          ? 'bg-indigo-100/70 text-indigo-900'
                          : ''
                      }`}
                    >
                      {para}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Delete button */}
          {onDelete && podcast.status !== 'generating' && (
            <div className="pt-2 border-t border-slate-100">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 flex-1">Delete this podcast?</span>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={isDeleting}
                    className="px-3 py-1.5 text-xs font-medium text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    Delete
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={12} />
                  Delete podcast
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Podcast View
// ============================================================================

export const PodcastView: React.FC<PodcastViewProps> = ({ user, isOnline, items, onScroll, podcastQueue = [], onAddToQueue, onRemoveFromQueue, onClearQueue }) => {
  const [podcasts, setPodcasts] = useState<PodcastMetadata[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [showAddWords, setShowAddWords] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track previous podcast statuses for notification (item 9)
  const prevPodcastsRef = useRef<PodcastMetadata[]>([]);

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Subscribe to podcasts
  useEffect(() => {
    if (!user) {
      setPodcasts([]);
      return;
    }

    const unsubscribe = subscribeToPodcasts(user.uid, (data) => {
      // Check for generation completion → browser notification (item 9)
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        const prev = prevPodcastsRef.current;
        for (const p of data) {
          if (p.status === 'ready') {
            const wasPrevGenerating = prev.find(pp => pp.id === p.id && pp.status === 'generating');
            if (wasPrevGenerating) {
              new Notification('Podcast Ready', {
                body: `Your ${p.wordCount}-word podcast is ready to play!`,
                icon: '/icon-192.png',
              });
            }
          }
        }
      }
      prevPodcastsRef.current = data;

      setPodcasts(data);
      // Auto-expand latest podcast only if nothing is currently expanded
      setExpandedId(prev => prev ?? (data.length > 0 ? data[0].id : null));
    });

    return unsubscribe;
  }, [user]);

  // Separate daily and manual podcasts
  const latestDaily = useMemo(() => podcasts.find(p => p.mode === 'daily'), [podcasts]);
  const historyPodcasts = useMemo(() => {
    if (!latestDaily) return podcasts;
    return podcasts.filter(p => p.id !== latestDaily.id);
  }, [podcasts, latestDaily]);

  // Resolve queued items to StoredItem objects
  const queuedItems = useMemo(() => {
    return podcastQueue
      .map(id => items.find(item => item.data.id === id))
      .filter((item): item is StoredItem => !!item && isVocabItem(item));
  }, [podcastQueue, items]);

  // Deduplicate queued items by word spelling for display
  const queuedWordGroups = useMemo(() => {
    const groupMap = new Map<string, { word: string; chinese: string; ids: string[] }>();
    for (const item of queuedItems) {
      const spelling = getItemSpelling(item);
      const data = item.data as VocabCard;
      const existing = groupMap.get(spelling);
      if (existing) {
        existing.ids.push(item.data.id);
      } else {
        groupMap.set(spelling, { word: data.word, chinese: data.chinese, ids: [item.data.id] });
      }
    }
    return Array.from(groupMap.values());
  }, [queuedItems]);

  // Check if any podcast is currently generating
  const isAnyGenerating = useMemo(() => podcasts.some(p => p.status === 'generating'), [podcasts]);

  // "Add 30 weakest" — compute weakest words client-side (item 2)
  const weakest30Ids = useMemo(() => {
    const vocabItems = items.filter(i => isVocabItem(i) && !i.isDeleted && !i.isArchived);
    if (vocabItems.length === 0) return [];

    // Sort by memoryStrength ASC (weakest first)
    const sorted = [...vocabItems].sort((a, b) => {
      const sa = a.srs?.memoryStrength ?? 100;
      const sb = b.srs?.memoryStrength ?? 100;
      return sa - sb;
    });

    // Take top 30 and return all their IDs
    return sorted.slice(0, 30).map(i => i.data.id);
  }, [items]);

  const handleAddWeakest = () => {
    if (onAddToQueue && weakest30Ids.length > 0) {
      onAddToQueue(weakest30Ids);
    }
  };

  const handleGenerateFromQueue = async () => {
    if (queuedItems.length === 0) return;
    const ids = queuedItems.map(item => item.data.id);

    setIsGenerating(true);
    setGenerationError(null);

    try {
      const result = await generatePodcast(ids);
      // Clear queue immediately — the backend already has the words
      onClearQueue?.();
      setExpandedId(result.id);
    } catch (err: any) {
      setGenerationError(err.message || 'Failed to start podcast generation');
    } finally {
      setIsGenerating(false);
    }
  };

  // Delete a podcast (item 5)
  const handleDeletePodcast = async (podcastId: string) => {
    await deletePodcastService(podcastId);
    // Real-time subscription will remove it from the list
    if (expandedId === podcastId) setExpandedId(null);
  };

  // Retry a failed podcast (item 6)
  const handleRetryPodcast = async (podcastId: string) => {
    await retryPodcastService(podcastId);
    // The doc will be re-created, real-time subscription picks it up
  };

  // Not signed in state
  if (!user) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 mx-auto mb-4 bg-violet-100 rounded-2xl flex items-center justify-center">
            <Headphones size={32} className="text-violet-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">Vocabulary Podcasts</h2>
          <p className="text-sm text-slate-500 leading-relaxed">
            Sign in to access AI-generated podcasts that help you memorize your saved vocabulary through engaging audio lessons.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={scrollRef}
      className="h-full overflow-y-auto"
      onScroll={onScroll}
    >
      <div className="max-w-2xl mx-auto px-4 py-6 pb-32 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-violet-200">
            <Headphones size={24} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Podcasts</h1>
            <p className="text-sm text-slate-500">AI-generated vocabulary lessons</p>
          </div>
        </div>

        {/* Section A — Latest Daily Podcast */}
        {latestDaily && (
          <section>
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Radio size={12} />
              Latest Daily Podcast
            </h2>
            <PodcastCard
              podcast={latestDaily}
              isExpanded={expandedId === latestDaily.id}
              onToggleExpand={() => setExpandedId(expandedId === latestDaily.id ? null : latestDaily.id)}
              onDelete={handleDeletePodcast}
              onRetry={handleRetryPodcast}
            />
          </section>
        )}

        {/* Empty state when no podcasts */}
        {podcasts.length === 0 && !isGenerating && queuedItems.length === 0 && (
          <div className="bg-gradient-to-br from-violet-50 to-indigo-50 rounded-2xl p-6 text-center">
            <div className="w-14 h-14 mx-auto mb-3 bg-white rounded-xl flex items-center justify-center shadow-sm">
              <Radio size={24} className="text-violet-500" />
            </div>
            <h3 className="font-semibold text-slate-800 mb-1">No podcasts yet</h3>
            <p className="text-sm text-slate-500 leading-relaxed mb-4">
              Daily podcasts are generated automatically at 2 PM UTC with your 30 weakest words. 
              You can also queue words while reviewing, or pick them below.
            </p>
          </div>
        )}

        {/* Podcast Queue — single source for generation */}
        <section>
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Headphones size={12} />
            Podcast Queue
            {queuedWordGroups.length > 0 && (
              <span className="bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {queuedWordGroups.length}
              </span>
            )}
          </h2>

          <div className="bg-white rounded-2xl border border-violet-100 shadow-sm overflow-hidden">
            {queuedWordGroups.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-sm text-slate-400 mb-1">No words in queue</p>
                <p className="text-xs text-slate-400 mb-3">Add words from the list below, or tap "Add to Podcast" while reviewing cards</p>
                {weakest30Ids.length > 0 && onAddToQueue && (
                  <button
                    onClick={handleAddWeakest}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-violet-100 hover:bg-violet-200 text-violet-700 text-sm font-medium rounded-xl transition-colors"
                  >
                    <Zap size={14} />
                    Add {Math.min(weakest30Ids.length, 30)} weakest words
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="max-h-48 overflow-y-auto divide-y divide-slate-50">
                  {queuedWordGroups.map(group => (
                    <div key={group.word} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm text-slate-800">{group.word}</div>
                        <div className="text-xs text-slate-500 truncate">{group.chinese}</div>
                      </div>
                      <button
                        onClick={() => group.ids.forEach(id => onRemoveFromQueue?.(id))}
                        className="text-slate-300 hover:text-red-500 transition-colors shrink-0 p-1"
                        title="Remove from queue"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="border-t border-slate-100 px-4 py-3 space-y-2">
                  {generationError && (
                    <div className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2 flex items-center gap-2">
                      <AlertCircle size={14} />
                      {generationError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={onClearQueue}
                      className="flex-1 py-2.5 text-sm font-medium text-slate-500 hover:text-slate-700 border border-slate-200 rounded-xl transition-colors"
                    >
                      Clear
                    </button>
                    <button
                      onClick={handleGenerateFromQueue}
                      disabled={isGenerating || isAnyGenerating || !isOnline}
                      className="flex-[2] py-2.5 text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-xl transition-colors flex items-center justify-center gap-1.5"
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Starting...
                        </>
                      ) : isAnyGenerating ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Generation in progress...
                        </>
                      ) : (
                        <>
                          <Wand2 size={14} />
                          Generate ({queuedWordGroups.length} word{queuedWordGroups.length !== 1 ? 's' : ''})
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Add Words section — feeds into the queue */}
        <section>
          <div className="flex gap-2">
            <button
              onClick={() => setShowAddWords(!showAddWords)}
              className="flex-1 bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors"
            >
              <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center shrink-0">
                <Plus size={18} />
              </div>
              <div className="flex-1 text-left">
                <div className="font-semibold text-sm text-slate-800">Add Words to Queue</div>
                <div className="text-xs text-slate-500">Browse vocabulary or add weakest</div>
              </div>
              {showAddWords ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
            </button>
          </div>

          {showAddWords && onAddToQueue && (
            <div className="mt-3 bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3">
              {/* Quick-add 30 weakest */}
              {weakest30Ids.length > 0 && (
                <button
                  onClick={handleAddWeakest}
                  className="w-full flex items-center gap-2 px-3 py-2.5 bg-violet-50 hover:bg-violet-100 text-violet-700 rounded-xl transition-colors"
                >
                  <Zap size={16} />
                  <div className="flex-1 text-left">
                    <div className="text-sm font-medium">Add {Math.min(weakest30Ids.length, 30)} weakest words</div>
                    <div className="text-xs text-violet-500">Fills queue with your most struggled words</div>
                  </div>
                </button>
              )}
              <WordAdder
                items={items}
                queuedIds={podcastQueue}
                onAddToQueue={onAddToQueue}
              />
            </div>
          )}
        </section>

        {/* Section C — History */}
        {historyPodcasts.length > 0 && (
          <section>
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Clock size={12} />
              History
            </h2>
            <div className="space-y-2">
              {historyPodcasts.map(podcast => (
                <PodcastCard
                  key={podcast.id}
                  podcast={podcast}
                  isExpanded={expandedId === podcast.id}
                  onToggleExpand={() => setExpandedId(expandedId === podcast.id ? null : podcast.id)}
                  onDelete={handleDeletePodcast}
                  onRetry={handleRetryPodcast}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
