# DictProp — Product Summary

**An AI-powered vocabulary learning app that helps you truly remember words, not just look them up.**

---

## The Problem

1. **Traditional dictionaries** give you definitions but don't help you *remember* them.
2. **Flashcard apps** require manual setup and treat every word the same — regardless of difficulty.
3. **You keep forgetting words** you've looked up before.
4. **Words have multiple meanings** but most tools only show you one, leaving you confused in context.
5. **No connection between lookup and learning** — searching and studying are separate activities.

## The Solution

DictProp combines AI-powered deep analysis with science-backed memory techniques to make vocabulary stick permanently. It bridges the gap between "looking up" and "learning" in one seamless experience.

---

# Core Experience

## 1. Smart Search — Deep Understanding in Seconds

### The Search Interface

**Input Area:**
- Large, comfortable text input at the top of the screen
- Supports multiline input for sentences and paragraphs
- **Paste & Search button** — One tap to paste clipboard content and immediately search
- **Clear button (X)** — Quickly clear the input to start fresh
- **Start Search button** — Triggers the AI analysis

**Zero State (Empty Search):**
- Welcoming prompt: "What would you like to learn?"
- Suggested examples with icons to inspire exploration:
  - 📚 "serendipity" (vocabulary)
  - 💬 "break the ice" (idiom)
  - ⏰ "ephemeral" (advanced word)
  - 🎯 "hit the nail on the head" (phrase)
- Tapping any suggestion immediately searches it

**Loading State:**
- Previous results stay visible (dimmed) while loading new search
- Prevents jarring blank screens during analysis

---

### Word Mode vs. Sentence Mode

The AI automatically detects whether you entered a **word/phrase** or a **full sentence** and responds differently:

#### Detection Logic:
- **Word Mode:** Single words, or 2-5 words without sentence punctuation
- **Sentence Mode:** 6+ words, or ends with `.!?`, or contains auxiliary verbs (is, are, have, will, etc.)

---

### Word Mode — Deep Vocabulary Analysis

**When you search a single word like "bank":**

The AI creates **separate vocabulary cards for each distinct meaning**. This is critical — most dictionaries show you one definition, but words have many lives.

**Example output for "bank":**

**Card 1: bank (noun: finance)**
| Field | Content |
|-------|---------|
| Word | bank |
| Sense Label | noun: finance |
| Chinese | 银行 |
| IPA | /bæŋk/ 🔊 *(tap to pronounce)* |
| Definition | A financial institution that holds deposits, makes loans, and provides other financial services |
| Word Forms | banks, banking, banked |
| Synonyms | financial institution, lender, credit union |
| Antonyms | debtor, borrower |
| Confusables | bench (similar sound), blank (spelling) |
| Examples | "I need to go to the bank to deposit this check." / "The bank approved our mortgage application." |
| Etymology | From Italian "banca" meaning bench, where medieval money changers conducted business |
| Register | Neutral, everyday usage |
| Mnemonic | Think of a "piggy BANK" where you store money |
| Image | AI-generated icon of a bank building |

**Card 2: bank (noun: geography)**
| Field | Content |
|-------|---------|
| Word | bank |
| Sense Label | noun: geography |
| Chinese | 河岸，堤岸 |
| IPA | /bæŋk/ |
| Definition | The sloping land beside a river, lake, or canal |
| Word Forms | banks |
| Synonyms | shore, edge, embankment, riverside |
| Antonyms | channel, riverbed |
| Confusables | beach (different water body), shore (more general) |
| Examples | "We had a picnic on the bank of the river." / "The children played along the grassy bank." |
| Etymology | From Old Norse "bakki" meaning ridge or hill |
| Register | Neutral, slightly literary |
| Mnemonic | Picture a river with steep BANKs on either side |
| Image | AI-generated icon of a riverbank |

**Card 3: bank (verb: to rely on)**
| Field | Content |
|-------|---------|
| Word | bank |
| Sense Label | verb: to rely on |
| Chinese | 指望，依靠 |
| IPA | /bæŋk/ |
| Definition | To depend or rely on something happening |
| Word Forms | banks, banking, banked |
| Synonyms | count on, rely on, depend on, trust |
| Antonyms | doubt, distrust, question |
| Confusables | bet on (more informal), count on (more common) |
| Examples | "Don't bank on getting a raise this year." / "We're banking on good weather for the wedding." |
| Etymology | From the gambling term "to bank" meaning to bet on a sure thing |
| Register | Informal, conversational |
| Mnemonic | You "bank on" something like you'd trust a bank with your money |
| Image | AI-generated icon of crossed fingers |

**Card 4: bank (verb: aviation)**
| Field | Content |
|-------|---------|
| Word | bank |
| Sense Label | verb: aviation |
| Chinese | 倾斜飞行 |
| IPA | /bæŋk/ |
| Definition | To tilt an aircraft to one side when turning |
| Word Forms | banks, banking, banked |
| Synonyms | tilt, roll, incline, veer |
| Antonyms | level out, straighten |
| Confusables | turn (more general), roll (more extreme) |
| Examples | "The pilot banked sharply to avoid the storm." / "Watch how the plane banks as it comes in to land." |
| Etymology | Related to "bench" — the tilting motion resembles a slanted surface |
| Register | Technical, aviation jargon |
| Mnemonic | The plane "banks" like a tilted riverBANK |
| Image | AI-generated icon of a tilted airplane |

---

**Visual Presentation:**

- Cards are displayed in a **horizontal carousel** — swipe left/right to browse meanings
- Number badges (1, 2, 3, 4) appear in corner of each card to indicate which meaning you're viewing
- Each card is **fully self-contained** — you can save any meaning independently
- Saved cards from the same word will be grouped in Notebook or Study flow

---

### Sentence Mode — Full Analysis

**When you search a sentence like "She couldn't help but bank on his promise, even though the evidence suggested otherwise.":**

**Hero Card Display:**
- **Featured image** — AI generates a contextual illustration based on a visual keyword (e.g., "trust", "hope")
- Large translation in Chinese at the top
- Original sentence with pronunciation guide (full IPA)

**Grammar Breakdown (formatted):**
```
**Structure Analysis:**
- "couldn't help but" — Double negative construction meaning "was unable to avoid"
- "bank on" — Phrasal verb meaning to rely or depend on
- "even though" — Concessive conjunction introducing contrast

**Nuance & Tone:**
- The sentence implies naivety or wishful thinking
- "couldn't help but" suggests an emotional, not rational, response
- Slight negative undertone — the speaker seems to disapprove

**Register:**
- Neutral to slightly formal
- Suitable for narrative writing or thoughtful conversation
```

**Key Vocabulary Extracted:**
- From the sentence, the AI identifies advanced (C1/C2) or interesting vocabulary
- Each extracted word gets the **full vocabulary card treatment** (same as Word Mode)
- Cards appear in a carousel below the hero card
- Example: "bank on" would be extracted and fully analyzed the same way as Word Mode

---

### The Search Flow — Step by Step

#### Path A: Word Already Saved (Instant, No API Call)

1. **User types or pastes text** into the search box
2. **User taps submit arrow** (or presses Enter)
3. **App checks local notebook** for matching word/phrase (case-insensitive)
4. **Match found!** → Saved content displayed instantly
   - No loading spinner
   - No API request
   - No network required (works offline)
   - SRS progress preserved
5. **Refresh button available** if user wants fresh AI analysis
6. **User can:**
   - View the saved content immediately
   - Tap Refresh to get new AI analysis (triggers Path B)
   - Browse, study, or explore synonyms as normal

**Why This Matters:**
- Instant results for saved vocabulary
- No API quota consumed
- Works completely offline
- Consistent experience — user sees what they saved

---

#### Path B: New Word (AI Analysis Required)

1. **User types or pastes text** into the search box
2. **User taps submit arrow** (or presses Enter)
3. **App checks local notebook** — no match found
4. **Loading state appears** — spinner, "Analyzing..."
5. **AI processes the input** (typically 2-5 seconds):
   - Detects word vs. sentence mode
   - Generates structured JSON response
   - Includes all meanings for words, or full analysis for sentences
6. **Results render immediately**
7. **Images generate asynchronously:**
   - Main hero image loads first
   - Individual vocab card images load one by one
   - Results are usable before images finish loading
8. **User can:**
   - Browse vocabulary cards (swipe carousel)
   - Tap any card to see full details
   - Save individual meanings to notebook
   - Tap any synonym/antonym/confusable to recursively search it
   - Go back to previous search (back arrow appears)

---

#### Detection Flow Diagram

```
User Searches "bank"
        │
        ▼
┌───────────────────────┐
│ Check saved items for │
│ matching word/phrase  │
└───────────────────────┘
        │
        ├── Match Found ──────────► Show saved content instantly
        │                           (No API call, works offline)
        │
        └── No Match ─────────────► Call Gemini AI API
                                    (Requires network, 2-5 sec)
```

---

#### Refresh Behavior

When viewing a saved item, a **Refresh button** (🔄) appears:

| Action | Result |
|--------|--------|
| View saved item | Shows cached content instantly |
| Tap Refresh | Triggers new AI analysis (Path B) |
| New analysis completes | Updates saved item with new content |
| SRS progress | Preserved (not affected by refresh) |
| Images | Regenerated with new prompts |

**Use Cases for Refresh:**
- AI prompts have been improved
- Want fresher example sentences
- Original analysis was incomplete
- Images failed to generate initially

---

### Recursive Search — Exploring Connected Words

**Clickable Pills:**
Every word in synonyms, antonyms, confusables, and word forms is tappable:
- Tap "rely on" from synonyms → immediate search for "rely on"
- Previous result stays in history (back arrow appears)
- Up to 5 searches stored in history stack
- Enables natural exploration of word relationships

**Back Navigation:**
- Back arrow appears after drilling into related words
- Returns to previous search result instantly (no re-fetch)
- Breadcrumb-like experience through vocabulary space

---

### Refresh & Update

**For saved items:**
- A "Refresh" button appears (circular arrow icon)
- Tapping re-searches with the latest AI model
- Updates the saved item with new analysis
- Preserves all SRS (study) progress

**Bulk Refresh:**
- Available in Notebook view
- Re-analyzes ALL saved items with latest AI
- Shows progress bar: "15/42 words processed"
- Useful when AI prompts are improved

---

## 2. Personal Notebook — Your Learning Library

### Saving Items

**From Search Results:**
- **Star/Sparkle icon** on each vocabulary card
- Tap to save → icon fills in, item appears in notebook
- Tap again to unsave → removed from notebook

**From Sentence Analysis:**
- **Bookmark icon** on the hero card saves the full phrase
- Individual vocab cards have their own save buttons
- You can save the phrase AND individual words separately

**What Gets Saved:**
- Full vocabulary card data (all fields)
- AI-generated images (stored locally + remote database, local read first)
- Initial SRS state (Memory Strength: 0, ready for first review)
- Timestamp of when saved

---

### Multiple Meanings — Grouped Carousel

**The Problem:**
"Bank" the financial institution and "bank" the riverbed are completely different concepts. If you only save "bank" once, which meaning did you learn?

**DictProp's Solution:**
Multiple meanings are saved as a **grouped unit** sharing:
- **Shared SRS progress** — all meanings of "bank" share the same memory strength
- **Unified review schedule** — when "bank" is due, all meanings reviewed together
- **Sense-specific content** — each meaning has its own definition, examples, etc.

**Grouped Display in Notebook:**
Words with the same spelling but different meanings are **automatically grouped together** in a carousel format:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│    ┌─────────────────────────────────────────────┐      │
│    │ ● bank                                      │      │
│    │   [/bæŋk/ 🔊]   [noun: finance]        DUE │      │
│    │    ↑ tap to pronounce                       │      │
│    │   银行                                       │      │
│    │   "I need to go to the bank..."            │      │
│    └─────────────────────────────────────────────┘      │
│                       ● ○ ○  ← dot indicators           │
└─────────────────────────────────────────────────────────┘
```

**Carousel Behavior:**
| Element | Function |
|---------|----------|
| Dot indicators (● ○ ○) | Visual position, tappable to jump |
| Swipe gesture | Swipe left/right to browse meanings |

**Key Points:**
- **One card visible at a time** — clean, uncluttered view
- **Grouped by spelling** — "bank" meanings stay together
- **Shared SRS progress** — all meanings share the same memory strength and review schedule
- **Individual actions** — long press any meaning to refresh/delete just that one

**Example:**
You saved 3 meanings of "bank":
- Navigate carousel: bank (finance) ↔ bank (river) ↔ bank (aviation)
- **All meanings share the same SRS** — when "bank" is due, review all meanings together
- Master all meanings of "bank" as a unit
- Delete just "bank (aviation)" without affecting the others

**Consistent Grouping Across App:**
| View | Grouping Behavior |
|------|-------------------|
| **Notebook** | Same-word meanings grouped in carousel |
| **Study Session** | Same-word meanings reviewed together, shared SRS |
| **Detail View** | Navigate between meanings with swipe |
| **Search Results** | All meanings shown in horizontal carousel |

**Shared SRS Benefit:**
All meanings of a word share one memory strength — when you review "bank", you're reinforcing knowledge of ALL its meanings together.

---

### Notebook Interface

**Header:**
- Title: "Notebook"
- Item count: "42 items saved"
- Filter/Sort controls

**List Display:**
- Each unique word/phrase appears as **one entry**
- Words with multiple meanings → **grouped carousel** (see above)
- Single-meaning words → regular card (no carousel controls)
- Scrollable list with all saved items
- **Archived section** at bottom (collapsed by default, tap to expand)

**Filter Options:**
- **All** — Everything
- **Vocabulary** — Single words only (Type icon)
- **Phrases** — Sentences and expressions (Layers icon)
- Cycle through by tapping the filter icon

**Sort Options:**
- **By Familiarity** — Struggling words first, mastered words last (based on lowest-strength meaning in group)
- **Alphabetical** — A-Z sorting by word/phrase
- Toggle by tapping the sort icon

**Action Buttons:**
- **Force Sync** — Push/pull from cloud immediately
- **User Menu** — Sign in/out, account info

---

### Notebook Item Cards

**Two Display Modes:**

| Word Type | Display |
|-----------|---------|
| Single meaning | Regular card (no carousel) |
| Multiple meanings | Grouped carousel (see "Multiple Meanings" section above) |

---

**Single-Meaning Card Layout:**
```
┌─────────────────────────────────────────────┐
│ ● serendipity                               │
│   [/ˌserənˈdɪpəti/ 🔊]              DUE    │
│   意外发现的好事                              │
│   ────────────────────────────────────────  │
│   "Finding that book was pure serendipity"  │
│   Origin: Coined by Horace Walpole...       │
└─────────────────────────────────────────────┘
```

**Multi-Meaning Grouped Carousel Layout:**
```
┌─────────────────────────────────────────────────────────┐
│                              [1/3 meanings]             │
│  ◀ ┌─────────────────────────────────────────────┐ ▶   │
│    │ ● bank                                      │      │
│    │   [/bæŋk/ 🔊]   [noun: finance]        DUE │      │
│    │   银行                                       │      │
│    │   "I need to go to the bank to deposit..."  │      │
│    └─────────────────────────────────────────────┘      │
│                       ● ○ ○                             │
└─────────────────────────────────────────────────────────┘
```

---

**Color-Coded Status Strip:**
- **Orange strip** — Due for review
- **Green strip** — Mastered (21+ day interval)
- **Gray strip** — Not due yet

**Tap Action:**
- Opens full **Detail View** with complete vocabulary card
- Larger format, scrollable, all information visible

**Long Press Action:**
- Long press (hold) on card reveals action buttons:
  - **Refresh** (circular arrow) — Re-search this word with AI
  - **Archive** (box icon) — Move to archive (won't appear in study sessions)
  - **Delete** (trash icon) — Remove from notebook (only this meaning if grouped)

---

### Archived Words

**What is Archive?**
Archive lets you keep words in your collection without them appearing in study sessions.

**Use Cases:**
| Scenario | Action |
|----------|--------|
| Already know this word perfectly | Archive it |
| Want to focus on other words first | Archive temporarily |
| Saved for reference, not learning | Archive it |
| Word no longer relevant to goals | Archive instead of delete |

**How to Archive:**
- **From Notebook:** Long press card → tap Archive
- **From Study:** Long press card → tap Archive
- **From Detail View:** Tap Archive button

**Where Archived Words Live:**
Archived words appear in a **separate section** at the bottom of Notebook:

```
┌─────────────────────────────────────────────┐
│  NOTEBOOK                                   │
│  ─────────────────────────────────────────  │
│                                             │
│  [Active Words - 42 items]                  │
│  ┌─────────────────────────────────────┐    │
│  │ serendipity                         │    │
│  │ ephemeral                           │    │
│  │ bank (3 meanings)                   │    │
│  │ ...                                 │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ─────────────────────────────────────────  │
│  📦 ARCHIVED (8 items)              [Show]  │
│  ─────────────────────────────────────────  │
│  ┌─────────────────────────────────────┐    │
│  │ ubiquitous                          │    │
│  │ paradigm                            │    │
│  │ ...                                 │    │
│  └─────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
```

**Archived Section Behavior:**
- Collapsed by default (tap to expand)
- Shows count of archived items
- Same card display as active words
- Long press to Unarchive or Delete

**Unarchiving:**
- Long press archived card → tap **Unarchive**
- Word returns to active list
- SRS progress preserved (resumes where it left off)

---

### Detail View — Full Card Experience

**Triggered by:**
- Tapping a notebook item
- Tapping "Expand" on any vocabulary card
- Tapping a study flashcard to see details

**TikTok-Style Vertical Navigation:**
Browse through vocabulary cards with a familiar, immersive experience:

```
┌─────────────────────────────────────────────┐
│                                             │
│         SERENDIPITY                         │
│         /ˌserənˈdɪpəti/ 🔊                  │
│                                             │
│         [AI Image]                          │
│                                             │
│         意外发现的好事                        │
│         The occurrence of events...         │
│                                             │
│         📖 Examples                         │
│         📜 Etymology                        │
│         💡 Mnemonic                         │
│                                             │
└─────────────────────────────────────────────┘
         ↕ swipe up/down (hidden gesture)
```

**Navigation Gestures (No Visible UI):**
| Gesture | Action |
|---------|--------|
| Swipe Up | Next word in list |
| Swipe Down | Previous word in list |
| Swipe Left/Right | Navigate between meanings (if multiple) |
| Tap | Interact with card content |

**Full-Screen Immersive Experience:**
- One card fills the entire screen
- Smooth snap-to-card scrolling
- Endless vertical browsing through your vocabulary
- **No arrows or indicators** — clean, distraction-free UI
- Gesture-based navigation (discoverable through use)

---

**Card Layout:**
Each full-screen card contains:
- Large word at top
- Sense label badge
- **Clickable IPA block** (tap to hear pronunciation)
- AI-generated image (if available, should be from local first, and then database second)
- Chinese translation
- English definition
- Word forms section
- Example sentences (word highlighted in context)
- Etymology panel (orange background)
- Mnemonic panel (green background)
- Synonyms (tappable pills)
- Antonyms (tappable pills)
- Confusables (tappable pills, amber colored)
- Register note at bottom

**Actions:**
- **Save/Unsave** — Toggle notebook status
- **Refresh** — Re-analyze with AI
- **Search** — Tap any pill to search that word
- **Audio** — Tap IPA block to hear pronunciation
- **Close** — Return to previous screen

**Multiple Meanings — Grouped Carousel in Detail View:**
If the word has multiple saved meanings:
- Swipe left/right to navigate between meanings
- Dot indicators show current position (● ○ ○)
- Swipe up/down still navigates to different words
- Each meaning's full content displayed one at a time

---

## 3. Adaptive Study Sessions — Memory That Lasts

### The Science Behind It

DictProp's SRS (Spaced Repetition System) is inspired by:
- **SuperMemo SM-2** — The original spaced repetition algorithm
- **Shanbay** — Chinese vocabulary app with memory strength model
- **Forgetting Curve Research** — Ebbinghaus's work on memory decay

**Core Concepts:**

#### Memory Strength (0-100)
A hidden score representing how well you know a word:
- **0** — Brand new, never reviewed
- **10-30** — Weak, easily forgotten
- **40-60** — Moderate, needs regular review
- **70-85** — Strong, longer intervals okay
- **90-100** — Near-permanent, months between reviews

You don't see the exact number, but you see **Mastery Levels**:
| Score Range | Label | Color |
|-------------|-------|-------|
| 0-10 | New | Gray |
| 10-30 | Struggling | Orange |
| 30-50 | Learning | Amber |
| 50-70 | Proficient | Blue |
| 70-85 | Mastered | Emerald |
| 85-100 | Grandmaster | Purple |

#### Stability
How long a memory lasts before significant decay:
- New words: ~0.5 days stability
- After successful reviews: Stability increases (up to 90 days)
- After failures: Stability decreases by 50%

#### Difficulty
An item's inherent difficulty (0-10):
- Starts at 5 (neutral)
- Increases if you consistently fail
- Decreases if you consistently succeed
- Affects how soon items come back for review

---

### How Reviews Affect Memory

**Quality Scores (0-5):**
| Score | Meaning | Effect |
|-------|---------|--------|
| 0 | Complete blackout | -25 memory strength |
| 1 | Wrong, but recognized when shown | -10 memory strength |
| 2 | Wrong, but close | -5 memory strength |
| 3 | Correct with effort | +5 memory strength |
| 4 | Correct, fairly easy | +12 memory strength |
| 5 | Instant, effortless recall | +20 memory strength |

**Study Mode:**
- Single mode: Recall (tap to flip, self-grade)
- Consistent experience across all reviews
- Green bar = knew it, red bar = didn't know

**Speed Bonus:**
Faster correct answers slightly boost memory strength:
- Very fast (< 50% expected time): +3 bonus
- Fast (< 80% expected time): +1 bonus
- Slow (> 200% expected time): -2 penalty

---

### Time Decay

**Between Reviews:**
Memory strength naturally decays over time using exponential decay:
```
Current Strength = Original Strength × e^(-days / (stability × 2))
```

**What this means:**
- High stability = slow decay
- Low stability = fast decay
- After 1 week with stability 3.5: ~60% of original strength remains
- After 1 month with stability 30: ~90% remains

**Practical Effect:**
- Review items before they decay too much
- App schedules reviews at ~85% retention probability
- You review words right before you'd forget them

---

### Study Session Flow

#### Dashboard View (Start Screen)

**Session Overview:**
```
┌─────────────────────────────────────────┐
│           TODAY'S STUDY                 │
│                                         │
│   🔥 15 words due                       │
│   📊 85% average retention              │
│   ⏱️ Estimated: 8 minutes               │
│                                         │
│   [ START SESSION ]                     │
│                                         │
├─────────────────────────────────────────┤
│   WEEKLY STATS                          │
│   Reviews: 127 | Accuracy: 82%          │
│   Streak: 5 days                        │
└─────────────────────────────────────────┘
```

**Start Session Button:**
- Shows number of due items
- Creates study queue from due items
- Prioritizes: lowest memory strength first, then oldest due

#### Active Study Session

**Flashcard Front:**
Shows the word/content to recall (no explicit "question" label):
- The word and its pronunciation
- Audio playback (tap IPA to hear)
- Card number: "3 of 15"
- Minimal UI — focus on the word itself

**Flashcard Back:**
Revealed after tapping the card:
- Full vocabulary card content
- Chinese translation
- Definition and examples
- Green/red bars for self-grading

**Self-Grading:**
Two simple color bars (no text labels):

```
┌─────────────────────────────────────────────┐
│                                             │
│   ████████████████   ████████████████       │
│      (green bar)        (red bar)           │
│       = Memorized      = Not Memorized      │
│                                             │
└─────────────────────────────────────────────┘
```

| Bar | Meaning | Effect |
|-----|---------|--------|
| 🟩 Green | Memorized / Correct | Maps to quality 4, increases memory strength |
| 🟥 Red | Not Memorized / Incorrect | Maps to quality 1, decreases memory strength |

- Clean, minimal UI — no text clutter
- Intuitive color coding (green = good, red = bad)
- Large tap targets for easy interaction

**Archive During Study:**
- Long press the flashcard to reveal Archive option
- Archived words are removed from the current session
- Won't appear in future study sessions
- Can be unarchived later from Notebook

**Post-Answer Feedback:**
Brief moment showing:
- Memory strength change (+15 or -10)
- New mastery level (if changed)
- Auto-advances to next card

---

### Study Mode — Recall

**Card Front:**
```
┌─────────────────────────────────────────────┐
│                                             │
│              BANK                           │
│              /bæŋk/ 🔊                       │
│                                             │
└─────────────────────────────────────────────┘
```

**Card Back (after tap):**

Full vocabulary card revealed — same detail as Search and Notebook:

```
┌─────────────────────────────────────────────┐
│                                             │
│  BANK                                       │
│  /bæŋk/ 🔊        [noun: finance]           │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │        [AI Generated Image]           │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  银行                                        │
│  A financial institution that holds         │
│  deposits, makes loans, and provides        │
│  other financial services                   │
│                                             │
│  ─────────────────────────────────────────  │
│  📖 USAGE                                   │
│  "I need to go to the bank to deposit..."   │
│  "The bank approved our mortgage..."        │
│                                             │
│  ─────────────────────────────────────────  │
│  📜 ORIGINS                                 │
│  From Italian "banca" meaning bench...      │
│                                             │
│  💡 MNEMONIC                                │
│  Think of a piggy BANK where you store...  │
│                                             │
│  ─────────────────────────────────────────  │
│  Synonyms: financial institution, lender    │
│  Antonyms: debtor, borrower                 │
│  Confusables: bench, blank                  │
│                                             │
│  ─────────────────────────────────────────  │
│                                             │
│   ████████████████   ████████████████       │
│      (green)            (red)               │
│                                             │
└─────────────────────────────────────────────┘
```

**Card Back Contains:**
- Word + IPA (clickable for audio)
- Sense label (if multiple meanings)
- AI-generated image
- Chinese translation
- English definition
- Example sentences
- Etymology/Origins
- Mnemonic
- Synonyms, Antonyms, Confusables
- Green/red bars at bottom for self-grading

**Interaction:**
- Tap card to flip and reveal full content
- Scroll if content is long
- Tap IPA to hear pronunciation
- Green bar = knew it, red bar = didn't know

---

### Review Scheduling

**When words appear for review:**
- Based on SRS algorithm (spaced repetition)
- Due items prioritized by memory strength (weakest first)
- Consistent Recall mode for all reviews

---

### Session Completion

**Summary Screen:**
```
┌─────────────────────────────────────────┐
│           SESSION COMPLETE! 🎉          │
│                                         │
│   ✓ 15 words reviewed                   │
│   ⏱️ 7 minutes 23 seconds               │
│   📊 87% accuracy                       │
│                                         │
│   MASTERY CHANGES                       │
│   ↑ 3 words improved                    │
│   ↓ 1 word needs work                   │
│                                         │
│   [ RETURN TO DASHBOARD ]               │
└─────────────────────────────────────────┘
```

**Confetti Animation:**
- Triggers on session complete
- Celebratory moment for finishing review
- Positive reinforcement

**Stats Recorded:**
- Session saved to Firebase (if signed in)
- Contributes to streaks
- Visible in analytics

---

### Handling Multiple Meanings in Study

**Grouped Carousel in Study Flow:**

Just like in the Notebook, words with multiple meanings are **grouped together** during study sessions:

```
┌─────────────────────────────────────────────┐
│                                             │
│              BANK                           │
│              /bæŋk/ 🔊                       │
│                                             │
│                ● ○ ○                        │
│                                             │
└─────────────────────────────────────────────┘
```

**How It Works:**
- Dot indicators (● ○ ○) show multiple meanings exist
- Swipe left/right to browse between meanings
- All meanings share one SRS score
- Single review updates all meanings of that word

**Why Shared SRS?**
- Learning "bank" means learning ALL its meanings
- When you encounter "bank" in real life, you need to know all senses
- One unified review ensures comprehensive understanding
- Simpler mental model — "I know bank" vs tracking 4 separate items

---

## 4. Cross-Device Sync — Learn Anywhere

### How Sync Works

**Data Storage Layers:**

1. **Local (IndexedDB)**
   - Primary storage, always available
   - Works completely offline
   - Stores all vocabulary cards, images, SRS data

2. **Cloud (Firebase Firestore)**
   - Backup and sync layer
   - Requires sign-in
   - Enables cross-device access

---

### Sign-In Flow

**Options:**
- Google Sign-In (recommended)
- Works on all platforms

**First Sign-In:**
1. User taps "Sign In" in Notebook header
2. Google OAuth popup/redirect
3. On success:
   - Local data uploaded to cloud
   - Remote data (if any) merged with local
   - Real-time listener established

**Subsequent Sign-Ins:**
- Automatic on app open (if previously signed in)
- Silent re-authentication
- Immediate sync of any changes

---

### Real-Time Sync

**How It Works:**
- Firestore real-time listeners
- Any change on one device → pushed to cloud → received by other devices
- Typically 3-7 seconds end-to-end

**Example Scenario:**
1. Phone: Save "serendipity"
2. Cloud: Receives update, stores it
3. Tablet: Real-time listener fires
4. Tablet: "serendipity" appears in notebook

**What Syncs:**
- All vocabulary cards (data)
- SRS states (memory strength, intervals, history)
- Saved/deleted status
- Timestamps

**Image Sync:**
- Images stored both locally AND in remote database
- Local always read first (faster, works offline)
- Remote serves as backup for new devices
- Can regenerate via "Refresh" if needed

---

### Smart Merging

**Conflict Resolution:**
When the same item is edited on two devices:
- **Winner: Most recent edit** (by timestamp)
- SRS data: Takes the most progressed state
- Deletions: Propagate across devices

**Soft Delete:**
- Deleted items marked as `isDeleted: true`
- Kept for 1 day to propagate deletions
- Then permanently removed

---

### Offline Support

**Capabilities When Offline:**
- ✓ Browse saved vocabulary
- ✓ Study due items
- ✓ SRS updates recorded locally
- ✗ New AI searches (requires internet)
- ✗ Sync to cloud (queued until online)

**Reconnection:**
- App detects online status
- Automatically syncs queued changes
- Merges any remote changes
- User sees "synced" status

**Offline Banner:**
- Yellow bar at top when offline
- "Offline mode — changes will sync when connected"
- Disappears when online

---

### Force Sync

**Manual Sync Button:**
- Available in Notebook header
- Spinning icon while syncing
- Use when:
  - Doubt if sync happened
  - Just signed in on new device
  - Want immediate cloud backup

---

## 5. Mobile-First Design

### Progressive Web App (PWA)

**What This Means:**
- Install from browser to home screen
- Launches like a native app (no browser chrome)
- Works offline
- Receives updates automatically

**Installation:**
- iOS: Safari → Share → Add to Home Screen
- Android: Chrome → Menu → Install App
- Desktop: Chrome → Install icon in URL bar

**PWA Features:**
- Custom app icon (192x192 and 512x512)
- Splash screen on launch
- Full-screen mode
- Standalone appearance

---

### Touch Interactions

**Touch Gestures:**
- **Vocabulary carousels:** Swipe left/right to browse meanings
- **Notebook cards:** Long press to reveal Refresh/Delete
- **Study flashcards:** Tap to flip, swipe to navigate

**Tap Targets:**
- All buttons minimum 44x44 pixels
- Comfortable for thumb use
- Active states for feedback

**Pull-to-Refresh:**
- Not implemented (would conflict with scroll)
- Use explicit Refresh buttons instead

---

### Responsive Layout

**Mobile (< 640px):**
- Single column layout
- Full-width cards
- Bottom navigation bar
- Optimized touch targets

**Tablet (640px - 1024px):**
- Slightly wider cards
- More padding
- Same navigation structure

**Desktop (> 1024px):**
- Centered content (max-width 768px)
- Larger typography
- Hover states on interactive elements

---

### Navigation

**Bottom Tab Bar:**
- Three tabs: Search | Notebook | Study
- Icons with labels
- Active state: indigo color, thicker icon
- Hides when scrolling down (more content space)
- Reappears when scrolling up

**Safe Areas:**
- Respects notch/Dynamic Island on iOS
- Proper bottom inset for home indicator
- Content never obscured by system UI

---

### Accessibility

**Visual:**
- High contrast text (slate-900 on white)
- Focus indicators on interactive elements
- Color not sole indicator of status (icons + color)

**Text:**
- Selectable text in vocabulary cards
- User can copy definitions, examples
- Long-press to select on mobile

---

## 6. User Account & Authentication

### Signed-In Mode

**Benefits:**
- Cloud backup (never lose data)
- Cross-device sync
- Study history preserved

**Account Display:**
- Profile photo in Notebook header
- Tap for dropdown menu:
  - Display name
  - Email
  - Sign Out button

### Sign-In Errors

**Unauthorized Domain:**
- Happens if hosting domain not in Firebase auth list
- Modal explains the issue
- Developer-facing (should be configured)

**Safari Privacy Settings:**
- iOS Safari may block sign-in if "Prevent Cross-Site Tracking" is on
- Modal explains how to fix
- Settings → Safari → toggle off

---

## 7. AI Content Generation — Behind the Scenes

### The AI Engine

**Model Used:**
- Google Gemini 2.5 Flash
- Optimized for speed and accuracy
- Structured JSON output for consistent formatting

### Word Mode Prompting

**What the AI is instructed to do:**

```
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SINGLE WORD or SHORT PHRASE.

Your task: Create comprehensive vocabulary cards for ALL meanings.

CRITICAL - MULTIPLE MEANINGS:
You MUST create SEPARATE cards for EACH distinct meaning:
- Different parts of speech = different cards (noun vs verb)
- Different contexts = different cards (technical vs casual)
- Different usages = different cards

Example: "bank" should produce 3+ cards:
1. bank (noun: finance)
2. bank (noun: geography)
3. bank (verb: to rely)
4. bank (verb: aviation)

Each card MUST have:
- Same 'word' field
- UNIQUE 'sense' field (e.g., "noun: finance")
- Definition, examples, synonyms specific to THAT meaning
- Different Chinese translations for each sense
- Confusables: words often confused with this one
- Forms: all grammatical variations
```

**Required Fields for Each Card:**
| Field | Description | Example |
|-------|-------------|---------|
| word | The vocabulary word | bank |
| sense | Brief meaning label | noun: finance |
| chinese | Chinese translation for this sense | 银行 |
| ipa | American IPA with stress marks (clickable → plays audio) | /bæŋk/ 🔊 |
| definition | English definition for this sense | A financial institution... |
| forms | Grammatical variations | banks, banking, banked |
| synonyms | Context-appropriate alternatives | financial institution, lender |
| antonyms | Opposites for this sense | debtor, borrower |
| confusables | Similar words (spelling/sound) | bench, blank |
| examples | 2 natural sentences | "I need to go to the bank..." |
| history | Etymology (1-2 lines) | From Italian "banca"... |
| register | Formality level | Neutral, everyday |
| mnemonic | Memory aid | Think of a piggy BANK... |
| imagePrompt | Illustration prompt | A modern bank building with columns |

### Sentence Mode Prompting

**What the AI is instructed to do:**

```
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SENTENCE or longer text.

Your task: Provide comprehensive analysis:
1. translation - Precise Chinese translation
2. grammar - Markdown explanation of grammar, nuance, tone
3. visualKeyword - One keyword for image generation
4. pronunciation - IPA for the full sentence
5. vocabs - Extract interesting C1+ vocabulary

For grammar, use Markdown formatting (bold, bullets).
Focus on what makes this sentence interesting for C1 learners.

For vocabs: Only extract C1/C2 level or idiomatic words.
Create separate cards for each relevant meaning.
```

**Required Fields for Sentence Analysis:**
| Field | Description |
|-------|-------------|
| translation | Full Chinese translation |
| grammar | Markdown-formatted explanation |
| visualKeyword | Single word for image generation |
| pronunciation | Full sentence IPA |
| vocabs | Array of vocabulary cards (same structure as Word Mode) |

### Detection Algorithm

**How the app decides Word Mode vs Sentence Mode:**

| Condition | Mode |
|-----------|------|
| Single word | Word Mode |
| 2-5 words without `.!?` | Word Mode |
| Ends with `.!?` | Sentence Mode |
| 6+ words | Sentence Mode |
| Contains "is, are, was, were, have, has, will, would, could, should, can, may, might" | Sentence Mode |
| Starts with "I, You, He, She, It, We, They, The, A, An, This, That, There, Here" | Sentence Mode |

---

## 8. AI Image Generation

### How Illustrations Are Created

**Model Used:**
- Gemini 2.5 Flash Image
- Generates vector-style icons
- Minimal, flat design aesthetic

**Prompt Template:**
```
(Icon style), minimal vector art, flat design, [user's prompt].
solid background. No text.
```

### Cost-Optimized Image Strategy

**Why Simple Images?**

Images are intentionally designed as **simple, low-complexity icons** rather than detailed illustrations:

| Design Choice | Reason |
|---------------|--------|
| Vector/icon style | Fewer tokens to generate |
| Minimal detail | Reduces AI processing cost |
| Flat design | Simple shapes = lower complexity |
| Solid backgrounds | No complex gradients or textures |
| No text in images | Avoids rendering complexity |
| Small display size | High resolution unnecessary |

**Token Consumption Optimization:**
- Simple prompts (~20-30 tokens)
- Icon-style output requires fewer generation steps
- No need for photorealistic quality
- Images displayed at small sizes (thumbnails, headers)
- Visual memory aid doesn't require high fidelity

**Quality vs. Cost Trade-off:**

| Approach | Quality | Cost | DictProp Choice |
|----------|---------|------|-----------------|
| Photorealistic | High | $$$ | ✗ |
| Detailed illustration | Medium-High | $$ | ✗ |
| Simple vector icon | Medium | $ | ✓ |
| No image | None | Free | Fallback only |

**The Philosophy:**
> Images serve as **visual memory anchors**, not art pieces. A simple icon of a bank building triggers the same memory association as a detailed photograph — but costs a fraction of the tokens.

### Aspect Ratios

| Context | Ratio | Use |
|---------|-------|-----|
| Hero card (sentence) | 16:9 | Landscape header |
| Vocabulary card | 4:3 | Square-ish thumbnail |
| General | 1:1 | Square |

### Image Storage

**Dual Storage Strategy:**
- Generated as base64 data URI
- Stored **locally** in IndexedDB (primary)
- Stored **remotely** in cloud database (backup)
- Typical size: 50-150KB per image

**Read Priority:**
| Priority | Source | When Used |
|----------|--------|-----------|
| 1st | Local (IndexedDB) | Always checked first — fastest |
| 2nd | Remote (Database) | Fallback if local missing |
| 3rd | Regenerate | If neither has image |

**Why Local First?**
- Instant loading (no network delay)
- Works offline
- Reduces bandwidth usage
- Better user experience

### Fallback Behavior

- If local missing: Check remote database
- If remote missing: Card displays without image
- Can regenerate via "Refresh"
- **Images are optional** — learning works perfectly without them

---

## 9. Audio & Pronunciation Features

### Clickable IPA — Tap to Pronounce

**The IPA is interactive!** Every IPA transcription in the app is a clickable element:

```
┌─────────────────────────────────────┐
│  bank                               │
│  ┌─────────────┐                    │
│  │ /bæŋk/ 🔊  │  ← Tap anywhere    │
│  └─────────────┘    to hear it!    │
└─────────────────────────────────────┘
```

**How It Works:**
1. User sees IPA transcription (e.g., `/bæŋk/`)
2. User taps the IPA block
3. Audio plays immediately via Text-to-Speech
4. Visual feedback shows playback state

**Design:**
- IPA displayed in a styled block/pill
- Speaker icon (🔊) indicates audio available
- Entire block is tappable (large touch target)
- Hover state on desktop, active state on mobile

### Text-to-Speech Technology

**Engine:**
- Browser's native Web Speech API
- `speechSynthesis` for pronunciation playback
- Works offline (uses system voices)
- No external API calls needed

**Voice Selection:**
- Prioritizes US English voices
- Falls back to any English voice
- Uses system default if no English available
- Consistent pronunciation quality

### Pronunciation Block Component

**Visual Design:**
```
┌─────────────────┐
│ /ˌserənˈdɪpəti/ │  ← Soft background color
│       🔊        │  ← Speaker icon
└─────────────────┘
```

**Interaction States:**
| State | Appearance |
|-------|------------|
| Default | Light indigo background, IPA text |
| Hover (desktop) | Slightly darker background |
| Tapped/Active | Scale animation, audio plays |
| Playing | Icon animates or pulses |

**Accessibility:**
- Large touch target (minimum 44px height)
- Works with keyboard (Enter/Space)
- Screen reader announces "Play pronunciation"

### Where Clickable IPA Appears

| Location | What Plays | Notes |
|----------|------------|-------|
| Search results | Word pronunciation | In vocabulary card header |
| Sentence analysis | Full phrase | In hero card |
| Vocabulary cards | Word | Each card has its own IPA |
| Notebook items | Word | Compact display |
| Study flashcards | Word | Before revealing answer |
| Detail view | Word | Larger, more prominent |

### Why IPA + Audio Together?

| Benefit | Description |
|---------|-------------|
| **Learn correct pronunciation** | Hear it, not just read it |
| **Reinforce IPA reading** | Connect symbols to sounds |
| **Instant feedback** | One tap, immediate audio |
| **Offline capable** | Works without internet |
| **Multi-sensory learning** | Visual IPA + auditory playback |

---

## 10. Error Handling & Edge Cases

### Search Errors

**Empty Search:**
- Submit button disabled when input is empty
- No network request made
- Input validation prevents accidental submissions

**API Quota Exceeded:**
- Gemini has daily usage limits
- When exceeded: "Daily AI limit reached. Please check your plan or try again later."
- Red error card with retry button
- User can still browse saved items

**Network Failure:**
- "Search failed. Please try again."
- Retry button available
- Offline banner appears if detected

**Invalid Response:**
- Malformed AI response handled gracefully
- Missing fields filled with defaults
- Vocab cards without required data filtered out

### Sync Errors

**Sign-In Failures:**
| Error | User Message |
|-------|--------------|
| Unauthorized domain | Modal explaining domain must be added to Firebase |
| Safari privacy block | Modal with instructions to disable tracking prevention |
| Popup closed | Silent (user intentionally cancelled) |
| Network error | "Sign-in failed. Please try again." |

**Sync Failures:**
- Changes saved locally regardless
- Will sync on next successful connection
- Error icon in header (if persistent)
- "Sync error" status shown

### Study Session Edge Cases

**Empty Queue:**
- "No words due for review!"
- Encourages user to add more words
- Shows time until next review

**All Words Mastered:**
- Celebratory message
- Shows mastery statistics
- Suggests adding new words

**Mid-Session Interruption:**
- If user closes app during study
- Progress up to that point is saved
- Queue resets on next session start

**Same Word, Multiple Meanings:**
- All meanings appear together as a **grouped carousel**
- User reviews all meanings of "bank" in one session (finance, river, aviation)
- Swipe through carousel to see each meaning
- Single SRS update applies to all meanings

---

## 11. Confirmation Dialogs & Modals

### Delete Confirmation

**When Triggered:**
- Long-press delete (optional)
- Bulk delete operations

**Dialog Content:**
```
┌─────────────────────────────────────┐
│         Delete this word?           │
│                                     │
│   This will remove "bank" from      │
│   your notebook and erase all       │
│   learning progress.                │
│                                     │
│   [ Cancel ]         [ Delete ]     │
└─────────────────────────────────────┘
```

### Bulk Refresh Confirmation

**When Triggered:**
- Tapping "Refresh All" in Notebook

**Dialog Content:**
```
┌─────────────────────────────────────┐
│       Refresh All Items?            │
│                                     │
│   This will re-search all 42        │
│   items with the latest AI          │
│   analysis.                         │
│                                     │
│   This may take a while and use     │
│   API quota.                        │
│                                     │
│   [ Cancel ]     [ Refresh All ]    │
└─────────────────────────────────────┘
```

### Bulk Refresh Progress

**During Operation:**
```
┌─────────────────────────────────────┐
│      Refreshing all items...        │
│                                     │
│   15 / 42 words processed           │
│   ████████░░░░░░░░░░░░░  36%       │
│                                     │
└─────────────────────────────────────┘
```

### Completion Dialogs

**Refresh Complete:**
```
┌─────────────────────────────────────┐
│         Refresh Complete            │
│                                     │
│   Processed: 42 unique words        │
│   Errors: 2                         │
│                                     │
│              [ OK ]                 │
└─────────────────────────────────────┘
```

**Session Complete:**
- Confetti animation
- Stats summary
- Return button

---

## 12. Animations & Transitions

### Loading Animations

**Search Loading:**
- Spinner with pulsing glow effect
- "Analyzing nuances..." text
- Smooth fade-in of results

**Sync Loading:**
- Small spinner in header
- Replaces sync icon
- Subtle, non-blocking

**Image Loading:**
- Placeholder with visual keyword
- Smooth fade-in when loaded
- Scale animation on appear

### Card Animations

**Save Action:**
- Star icon fills with color
- Subtle scale bounce (1.0 → 1.1 → 1.0)
- Satisfying feedback

**Long Press Actions:**
- Hold triggers after ~500ms
- Action buttons appear as overlay/modal
- Haptic feedback (if supported)

**Carousel Navigation:**
- Smooth scroll with momentum
- Snap-to-card behavior
- Dot indicators update instantly

### Flashcard Flip

**Reveal Animation:**
- 3D flip effect (Y-axis rotation)
- Front fades out, back fades in
- 0.3s duration
- Smooth easing curve

### Confetti Celebration

**Trigger:**
- Session completion
- Major milestone (e.g., 100 words mastered)

**Effect:**
- Colorful confetti bursts from center
- Multiple colors (indigo, violet, amber, emerald)
- Gravity-affected fall
- Fades after 2-3 seconds

### Navigation Transitions

**Tab Switching:**
- Instant content swap (no animation)
- Active tab indicator updates
- Maintains scroll position per tab

**Modal Open/Close:**
- Slide up from bottom
- Background dims
- Smooth easing

**Page Background Refresh:**
- Content refresh after 5+ minutes in background (iOS PWA)
- Prevents stale data

---

## 13. Data Persistence & Storage

### Local Storage (IndexedDB)

**Database Structure:**
- Database name: `dictprop_db`
- Object store: `vocab_items`
- Key: item ID (UUID)

**What's Stored Locally:**
| Data | Size (typical) | Notes |
|------|----------------|-------|
| Vocabulary card data | ~2KB per card | All fields |
| SRS state | ~500B per item | Memory strength, intervals, history |
| Images | ~50-200KB each | Base64 encoded |
| User preferences | ~100B | View state, last query |

**Storage Limits:**
- IndexedDB: ~50MB-1GB (browser dependent)
- Typical user with 500 words + images: ~100MB
- No practical limit for vocabulary data

### Cloud Storage (Firebase Firestore)

**Document Structure:**
```
users/{userId}/vocab_items/{itemId}
├── data (vocabulary card content)
├── type ("vocab" or "phrase")
├── srs (learning state)
├── savedAt (timestamp)
├── updatedAt (timestamp)
└── isDeleted (soft delete flag)
```

**What's NOT Synced:**
- Temporary UI state
- Search history

**Image Sync Strategy:**
- Images synced to remote database
- Local storage read first (faster)
- Remote used as backup for new devices

**Sync Debouncing:**
- Changes batched for 5 seconds
- Prevents excessive writes
- Reduces Firebase costs

### Data Migration

**From Old SRS Format:**
- Automatically detected on load
- Converts interval → stability
- Estimates memory strength from history
- Preserves all learning progress

**From LocalStorage (Legacy):**
- One-time migration to IndexedDB
- Happens silently on first load
- Old data cleaned up after migration

---

## 14. Performance Considerations

### Initial Load

**First Paint:**
- Static HTML shell renders immediately
- React hydrates within 1-2 seconds
- Functional within 2-3 seconds

**Data Loading:**
- IndexedDB read: ~50-200ms for 500 items
- Firebase sync: 1-3 seconds (depends on connection)
- Progressive loading: UI usable before sync completes

### Search Performance

**Typical Latency:**
| Stage | Time |
|-------|------|
| Input → API call | <50ms |
| AI processing | 2-5 seconds |
| Response parsing | <100ms |
| UI render | <100ms |
| Image generation | 3-8 seconds (async) |

**Optimizations:**
- Previous results cached during session
- Already-saved items shown instantly (no API call)
- Images load asynchronously
- Results usable before images finish

### Study Session Performance

**Queue Building:**
- Filters due items: O(n)
- Sorts by priority: O(n log n)
- Typically <50ms for 500 items

**Card Rendering:**
- Single card in view at a time
- Minimal DOM updates
- Smooth 60fps animations

### Memory Usage

**Typical Footprint:**
- Base app: ~20MB
- Per vocabulary card: ~5KB (without images)
- Per image: ~100KB
- 500 words + images: ~100MB total

**Cleanup:**
- Soft-deleted items purged after 30 days
- Old task history pruned (keeps last 50 per item)
- Images garbage collected with deleted items

---

## 15. Platform-Specific Behaviors

### iOS Safari

**PWA Installation:**
1. Open in Safari (required)
2. Tap Share button
3. Scroll down, tap "Add to Home Screen"
4. Confirm name, tap "Add"

**Known Issues:**
- OAuth requires redirect (not popup)
- "Prevent Cross-Site Tracking" can block sign-in
- Background refresh needed after 5+ minutes

**Workarounds:**
- App auto-reloads when returning from background >5min
- Sign-in uses redirect flow on iOS
- Modal explains privacy settings if sign-in fails

### Android Chrome

**PWA Installation:**
1. Open in Chrome
2. Tap menu (three dots)
3. Tap "Install App" or "Add to Home Screen"
4. Confirm installation

**Behavior:**
- Works like native app
- Notifications (future feature)
- Background sync (future feature)

### Desktop Browsers

**Supported:**
- Chrome (full support)
- Firefox (full support)
- Safari (limited PWA support)
- Edge (full support)

**Installation:**
- Chrome: Click install icon in URL bar
- Other browsers: Bookmark-based

**Keyboard Shortcuts:**
- Enter: Submit search
- Shift+Enter: New line in search
- Escape: Close modals

---

## 16. Accessibility Features

### Visual Accessibility

**Color Contrast:**
- Text: slate-900 on white (21:1 ratio)
- Links: indigo-600 (4.5:1 ratio)
- All text meets WCAG AA

**Color Independence:**
- Status never indicated by color alone
- Icons accompany color indicators
- Due status: Orange color + "DUE" badge

**Text Sizing:**
- Respects system font size preferences
- Minimum 14px for body text
- Headers scale proportionally

### Motor Accessibility

**Touch Targets:**
- Minimum 44x44 pixels
- Adequate spacing between targets
- Swipe gestures have button alternatives

**Keyboard Navigation:**
- Tab order follows visual order
- Focus indicators visible
- Enter activates focused elements

### Screen Reader Compatibility

**Semantic HTML:**
- Proper heading hierarchy (h1 → h2 → h3)
- Button elements for actions
- Lists for repeated items

**Labels:**
- Buttons have descriptive text or aria-labels
- Images have alt text
- Form inputs have labels

### Reduced Motion

**Respects System Preference:**
- Detects `prefers-reduced-motion`
- Disables confetti animation
- Reduces transition effects

---

## 17. Security & Privacy

### Data Privacy

**What's Collected:**
- Vocabulary you save
- Study progress
- Basic account info (email, name, photo from Google)

**What's NOT Collected:**
- Search queries (processed, not stored)
- Usage analytics (not implemented)
- Location data
- Device identifiers

### Data Storage

**Local:**
- All data stored in browser's IndexedDB
- Encrypted by browser (if device encrypted)
- Cleared if browser data cleared

**Cloud:**
- Firebase Firestore (Google Cloud)
- User data isolated by userId
- Firestore security rules enforce access

### Authentication

**Method:**
- Google OAuth 2.0
- No passwords stored
- Token-based session

**Session:**
- Persists until sign-out
- Automatic re-authentication
- Secure token refresh

---

## 18. Limitations & Known Issues

### Current Limitations

| Limitation | Reason | Workaround |
|------------|--------|------------|
| English only | AI prompt designed for English | N/A |
| Chinese translations only | Target audience | N/A |
| No import/export | Not implemented | Manual re-search |
| No social features | Privacy focus | N/A |
| Offline search unavailable | Requires AI | Study offline works |

### Known Issues

| Issue | Status | Notes |
|-------|--------|-------|
| iOS Safari sign-in can fail | Workaround documented | Disable tracking prevention |
| Images occasionally fail | Graceful fallback | Card works without image |
| Slow on very large notebooks (1000+) | Performance acceptable | May add pagination |
| Rare duplicate items | Can occur with sync conflicts | Manual deletion |

### Browser Requirements

**Minimum:**
- Chrome 80+
- Firefox 75+
- Safari 14+
- Edge 80+

**Required Features:**
- IndexedDB
- Web Speech API
- ES2020+ JavaScript
- CSS Grid/Flexbox

---

## 19. Future Considerations

### Potential Enhancements

**Content:**
- Support for additional languages
- Support for other translation languages
- Custom vocabulary lists import
- Shared word lists

**Learning:**
- AI-generated practice sentences
- Pronunciation scoring (speech recognition)
- Contextual hints during recall
- Spaced repetition customization

**Social:**
- Friend leaderboards
- Shared progress
- Vocabulary challenges

**Analytics:**
- Learning statistics dashboard
- Time spent per word
- Retention predictions
- Weak area identification

**Platform:**
- Native mobile apps
- Browser extension for inline lookup
- Desktop app (Electron)

---

# User Journeys

## Journey 1: First-Time User (Detailed)

**Context:** Sarah downloads DictProp after seeing it recommended for vocabulary learning.

### Step 1: First Launch
- Opens app → Sees Search view
- Large search box at top
- "What would you like to learn?" message
- Four suggested words with icons
- Clean, inviting interface

### Step 2: First Search
- Taps "serendipity" suggestion
- Search triggers immediately
- Sees loading spinner: "Analyzing nuances..."
- After 3 seconds, results appear

### Step 3: Discovering Rich Content
- Single vocabulary card (one meaning)
- Sees: word, IPA, Chinese translation
- Scrolls: definition, examples, etymology
- Notices: mnemonic, synonyms, confusables
- Image loads: abstract illustration
- Thinks: "This is way more than a dictionary!"

### Step 4: Saving First Word
- Taps star icon on card
- Star fills with color (satisfying animation)
- Word is now in notebook

### Step 5: Exploring Notebook
- Taps "Notebook" tab at bottom
- Sees one item: "serendipity"
- Card shows pronunciation, Chinese, example
- Orange status strip: "Due for review"

### Step 6: First Study Session
- Taps "Study" tab
- Dashboard shows: "1 word due"
- Taps "Start Session"
- Recall mode (tap to flip)

### Step 7: First Review
- Sees flashcard front: "SERENDIPITY" with IPA
- Thinks about the meaning
- Taps card to reveal answer
- Sees full vocabulary card with definition
- Taps green bar (knew it)
- Memory strength increases
- Session complete (1/1)

### Step 8: Signing In
- Goes to Notebook
- Taps user icon (top right)
- Taps "Sign in with Google"
- Completes OAuth flow
- Sees profile photo appear
- Data backed up to cloud

### Step 9: Next Day
- Opens app
- "serendipity" is due again (spaced repetition)
- Same Recall mode: tap to flip, self-grade
- Memory reinforced with each review
- Self-grades: green bar (knew it)

### Step 10: Building Habit
- Searches new words daily
- Studies due items each morning
- Watches mastery levels increase
- Serendipity: New → Learning → Proficient

---

## Journey 2: Power User (Detailed)

**Context:** Marcus is an avid reader who encounters new words constantly.

### Scenario A: Quick Lookup While Reading

**Reading an article on laptop, phone nearby:**

1. Encounters: "The policy had an ephemeral effect..."
2. Picks up phone, opens DictProp
3. Article still on laptop, copies "ephemeral"
4. In DictProp: Taps paste button (clipboard icon)
5. Word auto-pastes and search triggers
6. 3 seconds later: Full analysis appears
7. Sees 2 meanings:
   - ephemeral (adj: short-lived)
   - ephemeral (noun: short-lived organism)
8. Saves both meanings (2 separate items)
9. Returns to reading article

**Time spent:** ~15 seconds

### Scenario B: Deep Exploration

**Exploring word relationships:**

1. Viewing "ephemeral" results
2. Sees synonyms: transient, fleeting, momentary
3. Curious about "transient"
4. Taps "transient" pill
5. New search triggers, results appear
6. Back arrow now visible (history)
7. Sees 3 meanings of "transient":
   - transient (adj: temporary)
   - transient (noun: homeless person)
   - transient (noun: electrical spike)
8. Saves the adjective meaning
9. Taps "fleeting" from synonyms
10. Continues exploration...
11. Eventually taps back arrow multiple times
12. Returns to original "ephemeral" result

### Scenario C: Multi-Device Usage

**Morning:** Studies on phone during commute
- Reviews 15 due words
- 87% accuracy
- 2 words marked as "needs work"

**Afternoon:** Adds words on work computer
- Searches "paradigm shift"
- Saves the phrase

**Evening:** Reviews on tablet at home
- "paradigm shift" appears (synced from work)
- Studies remaining due items
- Progress synced across all devices

### Scenario D: Maintaining Large Collection

**After 6 months: 400+ saved items**

1. Opens Notebook
2. Filters: "Vocabulary only" (hides phrases)
3. Sorts: "By familiarity" (struggling words first)
4. Sees weakest words at top
5. Searches each to refresh memory
6. Uses "Refresh All" to update AI analysis
7. Progress bar: "Processing 127/400..."
8. New mnemonics and examples appear

---

## Journey 3: Professional English Improvement

**Context:** Wei is a software engineer at a US company, wanting to sound more natural in meetings.

### The Need

**Situation:**
- Speaks English fluently
- Sometimes uses awkward phrasing
- Wants to sound more native/professional

### Using DictProp

**Approach: Phrase-Focused Learning**

1. **Hearing unfamiliar phrases in meetings:**
   - "Let's circle back on this"
   - "We need to move the needle"
   - "That's a heavy lift"

2. **After meeting:**
   - Opens DictProp
   - Searches each phrase
   - Gets full analysis (Sentence Mode)

3. **Learning:**
   - Translation: "让我们稍后再讨论这个"
   - Register: "Business jargon, informal"
   - Grammar: Phrasal verb structure explained
   - Examples: Professional contexts shown

4. **Studying:**
   - Reviews phrases in Recall mode
   - Practices using them mentally
   - Eventually uses in meetings naturally

### Specific Example: "move the needle"

**Search Results:**
```
Translation: 产生明显效果/有所改变

Grammar:
- Idiomatic expression from analog gauges
- "The needle" refers to a measurement indicator
- "Move" means to cause change
- Used when discussing impact on metrics/goals

Register: Business jargon, informal professional

Examples:
- "Will this campaign actually move the needle on sales?"
- "We need initiatives that move the needle, not incremental changes."

Mnemonic: Picture a speedometer needle moving from 0 to 100
```

**Outcome:**
- Wei uses phrase in next meeting
- Sounds natural and confident
- Continues building business English vocabulary

---

## Journey 5: Casual Learner / Curious Reader

**Context:** Alex reads novels and wants to understand every word.

### The Scenario

**Reading "The Great Gatsby," encounters:**
> "In my younger and more vulnerable years my father gave me some advice that I've been turning over in my mind ever since."

### Looking Up "vulnerable"

1. Opens DictProp, searches "vulnerable"
2. Sees 2 meanings:
   - vulnerable (adj: susceptible to harm)
   - vulnerable (adj: emotionally open)

3. Fitzgerald's usage: emotionally open
4. Saves this specific meaning
5. Returns to reading with deeper understanding

### Looking Up "turning over"

1. Searches "turning over in my mind"
2. Sentence Mode activates
3. Grammar breakdown:
   - Phrasal verb "turn over"
   - Metaphor: thoughts as objects being examined
   - Continuous nature of deliberation

4. Key vocab extracted: "turn over" (phrasal verb)
5. Saves for later study

### Reading Habit Formed

**Weekly Pattern:**
- Reads 2-3 chapters
- Looks up 5-10 words/phrases
- Saves interesting ones
- Studies during weekend
- Reading comprehension deepens over time

---

## Journey 6: Parent Helping Child

**Context:** Mom helping 12-year-old with English homework.

### The Scenario

**Child's homework:** Use "ubiquitous" in a sentence.

1. Mom opens DictProp
2. Searches "ubiquitous"
3. Shows result to child:
   - Definition: "present everywhere"
   - Chinese: 无处不在的
   - Examples: "Smartphones have become ubiquitous in modern life."
   - Mnemonic: "UBI-quitous = Ubi is Latin for 'where' - it's everywhere!"

4. Child writes own sentence:
   > "WiFi has become ubiquitous in cities."

5. Mom saves word to her account
6. Reviews with child later

### Benefit

- Quick, reliable lookup
- Child-friendly examples
- Memory aids included
- Mom learns too

---

## Journey 7: Teacher Creating Vocabulary Lessons

**Context:** ESL teacher building vocabulary curriculum.

### The Approach

1. **Preparation:**
   - Searches unit vocabulary (20 words)
   - Reviews AI-generated content
   - Saves all words with multiple meanings

2. **In Class:**
   - Shows vocabulary cards on projector
   - Uses etymology for context
   - Reads example sentences aloud
   - Uses mnemonics as teaching tool

3. **Homework:**
   - Students install DictProp
   - Teacher shares word list
   - Students save and study independently

4. **Assessment:**
   - Teacher checks student mastery levels
   - (Hypothetical: shared progress view)
   - Identifies class-wide weak areas

---

## Edge Case Scenarios

### Scenario: Offline Usage

1. User is on airplane (no WiFi)
2. Opens DictProp
3. Sees offline banner: "Offline mode — changes will sync when connected"
4. Can browse all saved words
5. Studies due items normally
6. Progress saved locally
7. On landing: connects to WiFi
8. Changes sync automatically

### Scenario: Rare Word with Single Meaning

1. Searches "defenestration"
2. Only 1 meaning exists
3. Single vocabulary card appears
4. No carousel navigation (unnecessary)
5. Full detail available

### Scenario: Very Long Sentence

1. User pastes entire paragraph
2. AI processes (may take 5-7 seconds)
3. Sentence Mode analysis
4. Multiple vocabulary words extracted
5. Scrollable hero card
6. Vocabulary carousel below

### Scenario: Already Saved Word

1. Searches "ephemeral" (already saved)
2. App detects match in notebook
3. Shows saved version instantly (no API call)
4. Refresh button available for new analysis
5. SRS progress preserved

### Scenario: Multiple Devices, Same Time

1. User A saves "paradigm" on phone
2. User A (same account) saves "shift" on tablet
3. Both sync to cloud
4. Both devices receive each other's updates
5. Notebook shows both words on both devices
6. No conflicts (different items)

---

# Glossary of Terms

## Product Terms

| Term | Definition |
|------|------------|
| **Vocabulary Card** | A comprehensive card containing word, definition, translation, examples, etymology, and more |
| **Phrase** | A sentence or expression saved for learning (vs. single word) |
| **Sense** | A specific meaning of a word (e.g., "bank" has multiple senses) |
| **Notebook** | User's personal collection of saved vocabulary |
| **Archive** | Storage for words you want to keep but not study; excluded from study sessions |
| **Detail View** | Full-screen view of a vocabulary card with all information |

## Learning Terms

| Term | Definition |
|------|------------|
| **SRS** | Spaced Repetition System — algorithm that schedules reviews optimally |
| **Memory Strength** | 0-100 score representing how well you know a word |
| **Stability** | How long a memory lasts before significant decay |
| **Mastery Level** | User-friendly label (New → Grandmaster) based on memory strength |
| **Due Item** | Word scheduled for review (memory has decayed to target level) |
| **Quality Score** | 0-5 rating of recall quality during review |
| **Task Type** | Study exercise mode (Recall — tap to flip, self-grade) |
| **Interval** | Time until next scheduled review |

## Technical Terms (Simplified)

| Term | Definition |
|------|------------|
| **IndexedDB** | Browser database that stores your data locally |
| **Firebase** | Google's cloud service that syncs your data |
| **PWA** | Progressive Web App — website that works like a native app |
| **OAuth** | Secure sign-in method (used for Google Sign-In) |
| **TTS** | Text-to-Speech — converts text to audio pronunciation |
| **IPA** | International Phonetic Alphabet — pronunciation notation (clickable → plays audio) |

## UI Terms

| Term | Definition |
|------|------------|
| **Carousel** | Grouped view showing one card at a time with navigation arrows; used for multiple meanings of same word |
| **Pill** | Small clickable tag (for synonyms, antonyms, etc.) |
| **Hero Card** | Large featured card at top of search results |
| **Status Strip** | Colored bar indicating review status (due, mastered, etc.) |
| **Toast** | Brief notification message |
| **Modal** | Overlay dialog that requires interaction |

---

# Summary

## What DictProp Does

1. **Search** — AI analyzes any word or sentence instantly
2. **Understand** — Get every meaning with examples, etymology, and mnemonics
3. **Save** — Build a personal vocabulary library with multiple meanings
4. **Study** — Adaptive flashcards with spaced repetition
5. **Master** — Track progress from New → Grandmaster

## The Learning Cycle

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ENCOUNTER → UNDERSTAND → SAVE → STUDY → RETAIN → MASTER      │
│       │                                              │          │
│       └──────────── (revisit weak words) ←───────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Stage | What Happens |
|-------|--------------|
| Encounter | See unfamiliar word while reading |
| Understand | Search in DictProp, get deep AI analysis |
| Save | Tap star to add to notebook |
| Study | Review with adaptive flashcards |
| Retain | Memory strength builds over time |
| Master | Word becomes permanent vocabulary |

## Key Differentiators (Summary)

| Feature | DictProp | Most Alternatives |
|---------|----------|-------------------|
| Content Creation | AI-generated, zero effort | Manual entry required |
| Multiple Meanings | Separate cards per sense | Single definition |
| Visual Learning | AI illustrations | Text only |
| Pronunciation | IPA + audio | Often missing |
| Memory Science | Strength + stability + decay | Basic intervals |
| Study Mode | Recall (tap to flip) | Same for all words |
| Input Flexibility | Words, phrases, sentences | Limited |
| Setup Required | None | Significant |

## Core Value Proposition

### For Users

> **"I looked up a word and actually remembered it."**

DictProp solves the universal frustration of forgetting words you've already looked up. By combining instant AI analysis with proven memory science, it transforms passive lookup into active learning.

### For the Market

> **"The dictionary that teaches you."**

DictProp occupies a unique position: more depth than translation apps, less work than flashcard apps, more modern than traditional dictionaries.

## The Promise

**Stop forgetting. Start remembering.**

DictProp transforms vocabulary learning from passive lookup to active mastery. It's the dictionary that teaches you, the flashcard app that adapts to you, and the study partner that knows exactly what you need to review — all in one beautiful, free app.

---

# Appendix

## Quick Reference Card

### Navigation
| Tab | Purpose |
|-----|---------|
| Search | Look up words and phrases |
| Notebook | View and manage saved items |
| Study | Review due vocabulary |

### Actions
| Action | How |
|--------|-----|
| Save word | Tap ⭐ on card |
| Play audio | Tap IPA block (e.g., `/bæŋk/ 🔊`) |
| Archive item | Long press → 📦 |
| Unarchive item | Long press archived card → 📤 |
| Delete item | Long press → 🗑️ |
| Refresh item | Long press → 🔄 |
| Search related | Tap any pill (synonym, etc.) |
| View full card | Tap notebook item |
| Sign in | Tap user icon in Notebook |
| Force sync | Tap sync icon in Notebook |

### Mastery Levels
| Level | Strength | Color | Meaning |
|-------|----------|-------|---------|
| New | 0-10 | Gray | Just added |
| Struggling | 10-30 | Orange | Needs work |
| Learning | 30-50 | Amber | Making progress |
| Proficient | 50-70 | Blue | Getting comfortable |
| Mastered | 70-85 | Green | Strong retention |
| Grandmaster | 85-100 | Purple | Near-permanent |

### Study Mode
| Mode | Description |
|------|-------------|
| Recall | Tap to flip, self-grade with green/red bars |

---

# Technical Implementation Guide

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS |
| Icons | Lucide React |
| Backend | Firebase (Auth, Firestore, Functions) |
| AI | Google Gemini 2.5 Flash |
| Hosting | Firebase Hosting |
| PWA | vite-plugin-pwa |

## Project Structure

```
/
├── index.html              # Entry HTML
├── index.tsx               # React entry point
├── App.tsx                 # Main app component
├── types.ts                # TypeScript interfaces
├── vite.config.ts          # Vite + PWA config
├── firebase.json           # Firebase project config
├── firestore.rules         # Database security rules
├── components/
│   ├── VocabCard.tsx       # Vocabulary card display
│   ├── PronunciationBlock.tsx  # Clickable IPA component
│   ├── Button.tsx          # Reusable button
│   ├── ConfirmModal.tsx    # Confirmation dialogs
│   ├── ErrorModal.tsx      # Error display
│   ├── UserMenu.tsx        # Account dropdown
│   └── ...
├── views/
│   ├── Search.tsx          # Search view
│   ├── Notebook.tsx        # Notebook view
│   ├── StudyEnhanced.tsx   # Study session view
│   └── DetailView.tsx      # Full card view
├── services/
│   ├── firebase.ts         # Firebase initialization & auth
│   ├── geminiService.ts    # AI API calls (client-side)
│   ├── storage.ts          # IndexedDB operations
│   ├── sync.ts             # Cloud sync logic
│   ├── srsAlgorithm.ts     # Spaced repetition algorithm
│   └── speech.ts           # Text-to-speech
└── functions/
    └── src/
        └── index.ts        # Firebase Cloud Functions (AI endpoints)
```

---

## Firebase Setup

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create new project (e.g., "dictprop")
3. Enable these services:
   - **Authentication** → Google Sign-In
   - **Firestore Database** → Start in production mode
   - **Functions** → Blaze plan required
   - **Hosting** → For deployment

### 2. Firebase Configuration

Get your config from Firebase Console → Project Settings → Your Apps → Web App:

```javascript
// services/firebase.ts
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 3. Firestore Security Rules

Deploy these rules (`firestore.rules`):

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      match /items/{itemId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
      
      match /sessions/{sessionId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

### 4. Authentication Domain

Add your hosting domain to Firebase Console → Authentication → Settings → Authorized domains.

---

## Gemini AI Setup

### 1. Get API Key

1. Go to [Google AI Studio](https://aistudio.google.com)
2. Create API key
3. Store securely (never commit to git)

### 2. Set Firebase Secret

```bash
# Set the API key as a Firebase secret
firebase functions:secrets:set GEMINI_API_KEY
# Paste your API key when prompted
```

### 3. Cloud Functions

The app uses two Cloud Functions:

**analyzeInput** — Vocabulary/sentence analysis
- Detects word vs. sentence mode
- Uses Gemini 2.5 Flash with structured JSON output
- Returns vocabulary cards with all fields

**generateIllustration** — Image generation
- Uses Gemini 2.5 Flash Image model
- Generates minimal vector icons
- Returns base64 data URI

Deploy functions:
```bash
cd functions
npm install
npm run deploy
```

---

## Local Development

### 1. Install Dependencies

```bash
# Root project
npm install

# Functions
cd functions && npm install && cd ..
```

### 2. Run Development Server

```bash
npm run dev
# Opens at http://localhost:3000
```

### 3. Build for Production

```bash
npm run build
# Output in /dist
```

### 4. Deploy

```bash
# Deploy everything
firebase deploy

# Deploy only hosting
firebase deploy --only hosting

# Deploy only functions
firebase deploy --only functions
```

---

## Environment Configuration

### Package.json Dependencies

**Frontend (`package.json`):**
```json
{
  "dependencies": {
    "@google/genai": "^1.30.0",
    "canvas-confetti": "^1.9.4",
    "firebase": "^12.6.0",
    "lucide-react": "^0.554.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-markdown": "^10.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.14.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "~5.8.2",
    "vite": "^6.2.0",
    "vite-plugin-pwa": "^1.2.0"
  }
}
```

**Functions (`functions/package.json`):**
```json
{
  "engines": { "node": "22" },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^5.0.0",
    "@google/genai": "^1.30.0"
  }
}
```

---

## Data Models

### VocabCard
```typescript
interface VocabCard {
  id: string;
  word: string;
  sense?: string;      // e.g., "noun: finance"
  chinese: string;
  ipa: string;
  definition: string;
  forms?: string[];    // e.g., ["runs", "running", "ran"]
  synonyms: string[];
  antonyms: string[];
  confusables: string[];
  examples: string[];
  history: string;     // Etymology
  register: string;    // Formality level
  mnemonic: string;
  imagePrompt?: string;
  imageUrl?: string;   // Base64 data URI
}
```

### StoredItem (Database)
```typescript
interface StoredItem {
  data: VocabCard | SearchResult;
  type: 'vocab' | 'phrase';
  srs: SRSData;
  savedAt: number;
  updatedAt?: number;
  isDeleted?: boolean;  // Soft delete for sync
}
```

### SRSData
```typescript
interface SRSData {
  id: string;
  type: 'vocab' | 'phrase';
  nextReview: number;      // Timestamp
  interval: number;        // Minutes
  memoryStrength: number;  // 0-100
  stability: number;       // Days
  difficulty: number;      // 0-10
  totalReviews: number;
  correctStreak: number;
  taskHistory: TaskPerformance[];
}
```

---

## API Endpoints

### analyzeInput

**Request:**
```json
{
  "text": "serendipity"
}
```

**Response (Word Mode):**
```json
{
  "translation": "",
  "grammar": "",
  "visualKeyword": "serendipity",
  "pronunciation": "/ˌserənˈdɪpəti/",
  "vocabs": [
    {
      "word": "serendipity",
      "sense": "noun: happy accident",
      "chinese": "意外发现的好事",
      "ipa": "/ˌserənˈdɪpəti/",
      "definition": "The occurrence of events by chance...",
      "forms": ["serendipities", "serendipitous", "serendipitously"],
      "synonyms": ["luck", "fortune", "chance"],
      "antonyms": ["misfortune", "bad luck"],
      "confusables": ["synchronicity", "coincidence"],
      "examples": ["Finding that book was pure serendipity."],
      "history": "Coined by Horace Walpole in 1754...",
      "register": "Slightly formal, literary",
      "mnemonic": "SERENE + DIP + IT = dip into serene luck",
      "imagePrompt": "A person finding treasure by accident"
    }
  ]
}
```

### generateIllustration

**Request:**
```json
{
  "prompt": "A modern bank building with columns",
  "aspectRatio": "4:3"
}
```

**Response:**
```json
{
  "imageData": "data:image/png;base64,iVBORw0KGgo..."
}
```

---

## Key Implementation Details

### IndexedDB Storage
- Database: `dictprop_db`
- Store: `vocab_items`
- Primary key: `data.id`
- Used for offline-first storage

### Sync Strategy
1. Local changes saved to IndexedDB immediately
2. Changes synced to Firestore with 5-second debounce
3. Real-time listener receives cloud updates
4. Soft deletes (isDeleted: true) for sync propagation
5. Most recent timestamp wins on conflicts

### Text-to-Speech
- Uses browser's native `speechSynthesis` API
- Prioritizes US English voices
- Works offline with system voices

### PWA Configuration
- Service worker via vite-plugin-pwa
- Caches all static assets
- Runtime caching for fonts
- Standalone display mode

---

## Deployment Checklist

- [ ] Firebase project created
- [ ] Google Sign-In enabled in Firebase Auth
- [ ] Hosting domain added to authorized domains
- [ ] Firestore rules deployed
- [ ] Gemini API key set as Firebase secret
- [ ] Cloud Functions deployed
- [ ] PWA icons in `/public` (192x192, 512x512)
- [ ] Build passes (`npm run build`)
- [ ] Deploy (`firebase deploy`)

---

*Document Version: 2.0*
*Last Updated: December 2024*
*Total Sections: 19 + Appendix + Technical Guide*
*Estimated Reading Time: 50-65 minutes*
