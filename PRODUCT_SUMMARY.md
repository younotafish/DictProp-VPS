# DictProp: product summary

DictProp is a vocabulary app for advanced learners of English. You look up a word, phrase or sentence, and an AI writes a card for each meaning. Every meaning you save is scheduled for review with FSRS v6. Saved sentences and the example sentences on cards become listening lessons with a detailed analysis, and two reading tabs offer curated sentences: Real Life conversations and American essays. The app runs at https://dictprop.online as an installable web app for phones and laptops, and it admits one Google account, its owner's.

This document describes what the code does as of 16 November 2026. Keys and gestures match the in-app Gestures & shortcuts sheet, which is built from `services/shortcutSheet.ts`, the canonical list. README.md covers running the code; CLAUDE.md covers operating it.

## 1. Terms

| Term | Meaning |
|---|---|
| Card | One meaning (sense) of a word or expression, saved and scheduled on its own. A word with three saved meanings is three cards that share a spelling, and lists group them under it. |
| Saved sentence | A sentence saved from the search box, from a card's examples or from an example's lesson. It has its own schedule and is reviewed as a sentence lesson. |
| Real Life line, essay sentence | A sentence from a built-in collection. Its review record is created the first time you review it, and it is separate from any saved copy of the same text. |
| Got it | The one-tap review outside a study session. It records a Good rating. |
| Due | Reviewed before, and its next review time has come. The Study dashboard and the card header's clock count only these. |
| To review | Never reviewed, or due. The Notebook header, the sentence lesson's pill, the card's position line and the Sentences tab count these. |
| Memorized | Reviewed and not due yet: a filter on the sentence lists. |
| Memory strength | A 0-100 display score computed from FSRS stability: 18 × ln(1 + stability in days), rounded, at most 100. A stability of one day reads 12, a week 37, 47 days 70, 180 days 94. Scheduling never uses it. |
| New | A card or sentence never reviewed. A card's badge reads "New", with no percentage; the review chips on the Sentences tab and in a Real Life collection, and a Real Life row's pill, say "New" too. |
| Struggling, Learning, Proficient, Mastered, Grandmaster | A reviewed card under 30% memory strength, then from 30%, 50%, 70% and 85%. A badge reads, for example, "Learning 45%". |
| Archived | Kept in the library but left out of Study and out of the Notebook's main list. You archive a card yourself, or the offline usage audit archives a sense it rates British only, rare or dated, or specialized (section 14). |

## 2. Layout

- **Tabs.** Notebook, Sentences, Real Life, Essays and Study. On screens 768 px wide or more, a sixth button, "?", opens the Gestures & shortcuts sheet. Keys 1, 2 and 3 open Notebook, Sentences and Study; Real Life and Essays have no key.
- **Kept between visits.** The app reopens on the tab it was on, and each tab keeps its scroll position, search, filters and any open collection, essay or study session while you use the others.
- **The tab bar** hides while a list scrolls down past 100 px and returns on any scroll up. Tapping the tab you're on, or pressing its number, scrolls it to the top and brings the bar back; on Notebook and Sentences a second tap at the top puts the cursor in the tab's search box. A second tap within half a second is ignored.
- **The Sentences badge**, the only badge, is a violet count of saved sentences to review ("99+" above 99). Screen readers hear "Sentences, N to review".
- **The search button** floats at the bottom right, above the tab bar and above Study's grade buttons; over a card it sits higher, clear of the card's bottom row.
- **Notices** (undo, progress, sync trouble, offline, updates) stack in one column at the bottom centre, above the tab bar, and stop short of the search button's column (section 10).
- **Overlays.** The card view (full screen, for words and sentence lessons), the review popup (a bottom sheet on phones, a centred dialog on wider screens), the search box and results sheet, and dialogs open over the tabs. While one is open, the page and the tab bar are inert, and focus returns where it was when it closes. Lists behind an open card or popup don't re-sort as you review; they catch up a second after the changes stop.

## 3. Search

The search button opens a box from anywhere in the app. ⌘F (Ctrl+F elsewhere) opens or focuses it from anywhere, even from inside a text field; the browser's own Find never opens.

### 3.1 The box

- The placeholder reads "Look up a word, phrase or sentence…". Enter or Send looks up what you typed, in English or Chinese. After a lookup goes out, the box clears and closes; offline it stays open with its text.
- When the text reads as a sentence, a bookmark, "Save this sentence", saves it to the Sentences list ("Sentence saved", or "Sentence already saved"). The text stays in the box and the bookmark becomes a disabled check, so Send can still scan it.
- Up to six matching saved sentences appear under the box, headed "Saved sentences": exact matches with every keystroke, typo-tolerant ones 200 ms after typing pauses. ↑ and ↓ choose one, and Enter or a click opens it as a sentence lesson.
- Esc clears and closes the box; × closes it and keeps the text. Enter in an empty box opens the results.
- The same search runs lookups started elsewhere: the empty Notebook's box, Enter in the Sentences search box, a tap on any term chip or green word, the look-up gesture in a sentence lesson, Refresh with AI and Compare. The Notebook's own box, once the notebook has cards, runs a word's or phrase's lookup inside the Notebook instead (4.4); a sentence typed there comes to this search and is scanned.

### 3.2 Word or sentence

One rule, shared by the client and the server (`server/src/shared/query-mode.ts`), decides how a query is treated:

| Input | Treated as |
|---|---|
| Chinese with fewer than 8 Han characters and no comma or full stop followed by more text | word or phrase |
| 1 or 2 words | word or phrase |
| 7 or more words | sentence |
| 4 to 6 words ending in `.`, `!`, `?` or `…` | sentence |
| 3 to 6 words that start with a subject pronoun ("I", "they're"), with there/here/this/that or a wh-word plus an auxiliary, with an auxiliary question ("did you…"), or with a determiner, a subject and a verb ("the kids ran home", "the newly elected mayor resigned", "The well collapsed.") | sentence |
| anything else ("might as well", "the elephant in the room", "a much needed break") | word or phrase |

- **A word or phrase** is analyzed as one dictionary entry: one card per meaning, at most 8, ordered by usage label (most useful American usage first).
- **A typed sentence** is scanned first. The server picks out its advanced expressions (at most 12, in base form; Chinese is translated first), and each is looked up on its own in the background, carrying the sentence as its context. When nothing qualifies, the status line says "No advanced expressions in this sentence".
- **A saved word**, including an inflected form ("ran" finds "run") or an archived card, is answered from the library without a network call, and its result opens at once.
- An expression picked on screen that reads like a sentence is analyzed as one entry, not scanned.

### 3.3 The queue, the search button and the status line

- Lookups, comparisons and scans run in the background with no limit on how many run at once. Asking again for a result that's ready opens it and says its word, even offline; asking again for one still running shows "Still looking up “word”…" and sends nothing.
- A result opens by itself only when the library answered it or it is a refresh. A fresh AI result waits behind the search button and the status line.
- **The search button** spins while anything runs. It shows a red count of unseen results, an indigo count of running lookups while busy, and a faded grey count of ready results when idle. It drops the red count while the status line shows a new result.
- **The status line** is a dark pill in the notice stack, hidden while the box or the results sheet is open and while a decision dialog is open. It says "Looking up “gamut”…" (2 s), "Still looking up “gamut”…" (2 s), "Scanning…" while a scan runs, then for 3.5 s "Found 4 expressions — analyzing…" or "No advanced expressions in this sentence". A ready result then shows as its word ("gamut", or "gamut +2") with a View button until you've seen it.
- **Reloads.** Lookups still running and results not yet seen survive a reload: up to 20, asked within the last hour, run again afterwards and never open by themselves. A refresh comes back as a refresh only if it was still running; once its result is in, it comes back as a plain lookup, which the refreshed cards answer. Every lookup, comparison and scan refused because the session expired, up to 20 and each once, resumes after you sign in again, as what it was. An unexpected error in the search forgets everything it kept, so closing its error screen, or reloading, starts the search afresh.

### 3.4 The results sheet

- A bottom sheet up to 85% of the screen's height. It opens at the first unseen result, or the newest, and says its word. Closing it keeps the results.
- **Header:** the query; "i/n" meanings; ‹ › with "i/N" results when there are several; a spinner with the number of lookups and comparisons still running; a save button ("Save", "Save all N" or "All saved") for every meaning of the open result; and × "Dismiss this result", which drops the open result and shows the next.
- **Strip** (two or more results): a chip per result, with a red dot while unseen; **Save all**, every meaning of every result; and **Clear all**, which drops every finished result, closes the sheet and offers "Cleared 3 results" with Undo for 6 seconds.
- Each meaning is a full word card (5.2) with a Save button that never unsaves, Refresh and Compare. Dots, swipes and, on wider screens, chevrons move between meanings. Moving to another result or meaning stops only audio the sheet started, and says the word.
- An expression found in a pasted sentence or looked up from a sentence lesson shows "From your sentence: “…ran the gamut of emotions…”" above its meanings: about 40 characters each side, cut at word boundaries. The context stays on the device and isn't kept across a reload.
- A tap or click in the top quarter of the card area reads example 1, in the second quarter example 2; a second one pauses or resumes.
- A comparison opens in the same sheet. A lookup that returns no card says "No vocabulary card was returned."

**Keys (laptop):** ← → meanings; ↑ ↓ results; S saves the meaning (or says it's already saved); Shift+S saves every meaning of the open result; P says the word; E reads the first two examples (again: pause or resume, or past 85% start again; one still loading is left alone); Space plays or pauses (the first example when nothing plays; a read still loading is left alone); ⌘1-4 read example 1-4; Esc closes. Held keys other than the arrows act once, and a dialog above the sheet keeps the keys.

### 3.5 Errors and offline

- Failures collect in a red toast above the search button: the newest failure, "+N more", one action and ×. The action is **Retry** (or **Retry all**, which reruns every failure a retry could fix), or **Edit** for a word with no dictionary entry, which puts the text back in the box, selected. × clears them all; while a passing notice holds the toast (a request refused offline, a refresh that failed), × clears only that notice, and the failures it hid come back. A failure that neither could fix leaves after 6 seconds.
- Messages quote at most 40 characters of the query: "Couldn’t reach DictProp for “gamut”.", "The model did not finish “gamut” before the timeout.", "No dictionary entry found for “gamut”. Check the spelling and try again.", "Your session expired. Sign in again to retry “gamut”.", "The AI provider is temporarily unavailable for “gamut”.", "The AI provider rate-limited this request. Try again shortly."
- Offline, saved words and saved comparisons still open. Any other lookup, and any scan, says "You're offline, so only saved words can be looked up."; an unsaved comparison says "You're offline, so only saved comparisons can be opened."
- The server gives a lookup 300 s, a scan 240 s and a comparison 600 s, and takes at most 5,000 characters.

### 3.6 Refresh with AI

Refresh, from a card, the review popup, a Notebook row or the results sheet, runs the AI again even for a saved word. In the sheet it refreshes in place ("Refreshing…"), and a failure keeps the old result; elsewhere the fresh result opens when it's ready. When the word is saved, a meaning with the same sense label updates its card in place (keeping its schedule, save time and picture), a new meaning becomes a new card, and meanings the new answer leaves out stay. The undo pill offers "Refreshed “word”" for 6 seconds: Undo puts back the replaced cards exactly and removes the added ones, while a card reviewed meanwhile keeps its new schedule.

### 3.7 Comparisons

- A card's Synonyms or Confusables have a Compare button: pick up to 7 more words (8 in all) and press Go. The Notebook's compare mode picks 2 to 8 words.
- A saved comparison opens at once in the results sheet; a new one is generated in the background and lands there. It has a Key Difference summary, three dimensions (core meaning, register, collocation), two contextual examples, two or three common mistakes and a verdict.
- Comparisons are saved for the account on the server and cached on the device, and each word's card lists the ones that include it.

### 3.8 Text Analyzer

The Notebook's ⋯ menu opens "Analyze text", a full-screen dialog.

1. Paste a passage (English or Chinese) and press Scan Text (⌘Enter).
2. Choose from the words found. Each shows a level, its context and why it was picked. Words already in the notebook, in any form, are tagged "In notebook" and start unticked; the list is headed, for example, "8 found · 3 already saved".
3. Analyze & Save looks the words up one at a time and saves each new meaning; "Stop after current word" stops the run. A summary reports how many cards were saved.

Offline, scanning and Analyze & Save are disabled ("Offline. Text analysis requires an internet connection."). A passage with nothing advanced says "No advanced vocabulary found in this text". Escape closes the dialog, goes back to the text while you choose, and does nothing mid-analysis.

## 4. The Notebook

The Notebook lists your saved words and phrases; sentences live on the Sentences tab.

### 4.1 The list

- Cards are grouped by spelling. Within a group, meanings are ordered by usage label: Modern American, Current general English (and cards with no label), Specialized, British only, Rare or dated. A group with several meanings is a carousel: a sideways swipe or a two-finger trackpad swipe steps through them and loops; the dots jump; on wider screens ‹ › buttons step and loop too.
- A row shows the spelling, the IPA (a tap says the word in the system voice and doesn't open the card), the sense label when the group has several meanings, the Chinese, the first example and the etymology ("Origin").
- **Badges.** An orange "Due" badge marks a card to review; this badge keeps the word "Due" and includes cards never reviewed. A grey "Archived" badge marks archived cards. The left strip is orange for a card to review, emerald for one resting more than 21 days, grey otherwise. Rows show no memory label.
- Tapping a row opens the card view on the cards of the section it's in: the main list, the due block or the archived section (section 5).
- **The list stays put while you read.** Its clock is re-read only when you search, change the sort or filter, open a card, tap the Notebook tab, or come back to the tab or the app. A sync or an enrichment refreshes rows in place; only a card whose own schedule changed moves.

### 4.2 Header, sort and filter

- **Header:** "Notebook" over a line such as "1532 words · 12 reviewed today · 340 to review": the spellings under the filter, the meanings reviewed since local midnight, and the spellings with a card to review. During a search it still counts the whole notebook. The header slides away as you scroll down.
- **Buttons:** ⋯ (tools), Compare, Filter, Sort, and the user menu (avatar, refused reviews, Sign out).
- **Sort:** Review Priority, the default (cards to review first, weakest memory strength first, then the longest overdue; then the rest by next review), or A-Z. Archived cards always sort A-Z.
- **Filter** cycles All items, Words and Phrases. Words, the default, are word cards, which include multi-word expressions; Phrases are the phrase items older versions of the app saved (5.7). The sort and filter are kept on the device.

### 4.3 Searching the notebook

- The box ("Search or look up new word") filters as you type. A card matches when its spelling, Chinese or translation contains the text, or when the text is an inflected form of it ("ran" lists "run"). With no such match, typo-tolerant matches arrive 300 ms after typing pauses.
- **Order:** the exact spelling; a saved base word; spellings that start with the text; spellings with a word that starts with it ("bank" in "break the bank"); spellings that contain it; Chinese or translation matches; typo-tolerant guesses. Within each tier, the sort applies.
- **After the results** come "Archived matches · N", each row badged Archived, then a "Due for Review" block ("N words to revisit") with the cards to review the results leave out. Without a search, the list ends with a collapsed "Archived" section.
- The list jumps to the top when results arrive, the sort or filter changes, or an AI lookup starts; clearing the search returns to the row you were browsing.
- Esc clears the search, from the box or anywhere on the tab; with nothing to clear, Esc in the box leaves it, and elsewhere leaves compare mode. A swipe right across the search bar also clears it. On a phone, dragging the list puts the keyboard away.

### 4.4 The AI lookup in the Notebook box

- **Enter in the box runs the AI lookup**, by the owner's choice. So do the wand ("Search with AI (Enter)"), "Look it up with AI" under an empty result, and a voice transcript.
- For a word or phrase it always asks the AI, even for a saved word, and sends the text as typed. A sentence goes to the search instead and is scanned for its expressions, as in the search box (3.2).
- **Results** show above the list as "Search Results", a carousel of full word cards with Save. → and a swipe left loop; ← stops at the first card; each step says the word. Editing the text removes the result, its error and any lookup in flight (a change of case or spacing keeps them).
- **Offline**, Enter on a word or phrase says "You’re offline — showing saved matches only.", with Retry once you're back online; a sentence gets the search's offline notice (3.5). Other failures use the search's wording (3.5), with Retry only when it can help.
- **Voice search.** The mic shows while the box is empty (disabled offline) and records until tapped again; the speech is transcribed (Whisper large-v3-turbo) and looked up. Errors: "Voice search isn't available in this browser.", "Microphone access denied. Please enable microphone permissions.", "Couldn't start the microphone. Check that one is connected and not in use by another app.", "Voice transcription failed. Please try again."

### 4.5 Row actions and compare mode

- **Row actions.** A long press (half a second), a right-click or the row's ⋯ opens Refresh with AI, Archive (or Unarchive) and Delete. Only one row's actions are open at a time; scrolling, Esc or a tap elsewhere closes them, and that tap doesn't also open the card under it. Delete, Archive and Unarchive act at once on the meaning shown and offer Undo for 6 seconds.
- **Compare mode** (the scales button, disabled offline): tick 2 to 8 words anywhere in the list, the due and archived ones included, then press "Compare N Words" (3.7). Esc, × or the button leaves it.

### 4.6 The tools menu

| Row | What it does | Offline |
|---|---|---|
| Speech playback | Clear/Casual and voice speed (section 9) | works |
| Analyze text | The Text Analyzer (3.8) | needs a connection |
| Batch import | 4.8 | needs a connection |
| Import JSON | 4.8 | needs a connection |
| Download image pack | 4.9 | needs a connection |
| Sync now | Sends pending reviews, takes a full copy of the server's library and pushes: "Syncing…", then "Up to date", or "Couldn’t sync" with Retry | needs a connection |
| Generate speech cache | 9.5 | needs a connection |
| Restore server images | 4.9 | needs a connection |
| Merge duplicates | 4.7 | works |
| Gestures & shortcuts | The sheet (section 13) | works |

Rows that need a connection grey out with "Needs a connection" once the connection has been gone for 3 seconds.

### 4.7 Merge duplicates

- **The scan** finds groups of cards saved under different forms of one word (run, ran, running), archived cards included. With none, a pill says "No duplicates found" for 3 seconds.
- **The dialog** suggests a headword for each group, the base the other forms belong to ("run" for "ran"). A group starts ticked only when the evidence says it is one word; pairs that may be different words (find/found, lie/lay, saw/see, left/leave) start unticked under "Possibly different words", with each word's short definition. The button says what it will do, for example "Merge 5" over "relabels 7 cards, removes 2".
- **Merging** relabels the cards to the headword and joins their forms. For each sense label it keeps the more reviewed card (then the richer one) and removes the others; a card with no sense label is never merged away. It pushes at once, with no undo. Review progress isn't merged: each card keeps its own, as the dialog says. While the ticked merges remove cards, the dialog warns: "Merging removes 2 duplicate cards of the same sense. Close other open tabs and devices first, so sync doesn’t bring them back."

### 4.8 Batch import and Import JSON

**Batch import.** Paste a list and press "Import N words" (⌘Enter). Each line is a word or phrase; commas split a one-line paste or a line whose parts are all single words, and semicolons always split. The run goes on in the background, five words at a time: each word is analyzed as one entry, saved words are skipped, and every new meaning is saved. Afterwards the server's speech backfill runs quietly (9.5). A pill reads "Adding words · 12/40", with × to stop, then "Added 18 words · 2 already saved", "All 5 words are already saved", "Stopped · added 3 words", or a red "Couldn’t add 3 words" with Retry, which imports the failed words again.

**Import JSON.** Paste one object or an array, either simple cards (`word`, `chinese`, `ipa`, `definition` … `imageUrl`) or full saved items, and press "Import N cards" (⌘Enter).
- The server takes 5,000 items, 25 MB, five imports an hour and one at a time. It downloads the first 100 image URLs, within 8 minutes in all.
- While it runs, the box is read-only. It ends with "N cards imported · M images fetched · K skipped", and Sync now runs.
- Imported cards start unreviewed. A card without an id gets a new one, so importing the same cards twice duplicates them.
- After 12 minutes the app stops waiting: "The server took too long to answer. The import may still finish, so check your notebook before importing again."

### 4.9 Pictures on the device

- A picture loads from the device, then from the server, and is kept on the device once loaded; one that can't be found shows "No Image".
- After a sync, the app quietly stores the pictures of up to 60 cards due within 24 hours and of the 20 most recently saved, except with Save-Data on, on a 2G connection, or when storage is more than 85% full.
- **Download image pack** fetches every missing picture in the library, archived cards included, 20 at a time, soonest due first: "Offline images · 120/340" with ×, then "Saved 340 images for offline use", "Saved 300 of 340 images · 40 couldn’t download", "All images are already offline" or "No images to download".
- **Restore server images** uploads the pictures this device has that the server lacks, showing "Checking which images the server is missing…" and then "Restoring images to server: 3/12" on an indigo pill with a spinner, and ending with "Restored 12 images to the server", "Restored 10 of 12 images; 2 failed", "All images already on the server" or "Couldn’t restore images. Try again later." Pictures that failed to upload are also sent again by themselves after the next sync that gets through.

### 4.10 An empty notebook

It shows its header (the counts, the ⋯ menu and the user menu, without Compare, Filter or Sort) over "Your notebook is empty", "Search for a word or phrase to get started." and a box. That box sends its lookups to the search (section 3), so a sentence typed there is scanned.

## 5. The card view: words

### 5.1 Opening and moving

- The card view covers the screen. It opens from a Notebook row (paging through that section's cards), from Study's "Open card" (the card among the other meanings of its spelling) and from the words the study summary lists to look at again. The review popup doesn't open it.
- Moving to another word opens it at its top, on its first meaning; moving between meanings keeps the scroll position. A card that a delete or archive slides into the same place opens at its top. Each card says its word (system voice) as it shows, except during example auto-play.
- The card follows the library live: an edit from a sync or another device shows at once, and a card deleted elsewhere leaves the view: the card on screen stays where it is, and when it is the one deleted, the next one takes its place (the view closes after the last).

### 5.2 What a word card shows

From top to bottom:

- the headword and its sense label ("noun: emotion"); a usage badge when the card has one (Modern American, Current general English, British only, Rare or dated, Specialized current usage), which a tap explains; the IPA (a tap says the word, a second tap stops it) and a YouGlish link;
- the picture, beside the text on wide screens;
- the Chinese and an English definition of up to 25 words;
- links to Vocabulary.com, YouTube, TikTok, PlayPhrase, Wiktionary, Google Ngram and ChatGPT (opened with a prompt that asks for an illustrated explanation);
- Word Forms and Word Family (with part of speech and Chinese); a tap on any chip looks the term up;
- Usage, the examples (a new card gets two). The studied word is indigo, and up to two uncommon terms per example are green with a dotted underline; a tap looks one up. Each example has a speaker, a save button ("Sentence saved" once saved) and, in the card view, "Open sentence review";
- Origins (the etymology), Mnemonic and Register (how common the sense is and where it's used);
- Synonyms, Antonyms and Confusables, which look up on tap; Synonyms and Confusables also have Compare (3.7);
- Comparisons: saved comparisons that include the word.

### 5.3 The header and the position line

- **The header** starts hidden. A short pull down at the top of the card, or H, shows it; scrolling down hides it. While it's hidden, a round × stays at the top right, with dots for the meanings when there are several.
- **Top row:** Close, "i/N" meanings and Refresh with AI. A saved card adds Delete (the trash), a green Got it (Unarchive instead on an archived card) and ⋮ (Archive or Unarchive, Reset Memory Strength, Delete); an unsaved card shows Save.
- **Second row:** an "Archived" chip on archived cards; the memory badge ("New", or "Learning 45%"), a bar, the review count and the streak; the next review ("3d", "5h", or "due" once the time has passed; unlike the term in section 1, a never-reviewed card shows "due" too); and two library counts: a check with the meanings at 70% memory or more, titled "{n} meanings at 70% memory or more", and a clock with the number of due spellings, titled "{n} due (reviewed cards)".
- **The position line** ends the card when the view holds two or more words: "Word 12 of 230 · 5 to review after this", or "Word 12 of 230 · archived" on an archived card.

### 5.4 Actions

- **Got it** (the header button, R, or a double-click or double tap on blank space) records Good; on an archived card, whose header offers Unarchive instead, R and the double-click or double tap do nothing. A "Remembered!" card shows "Next review tomorrow", "in 4 days" or "in ~2 months" for 1.5 seconds while that card is on screen. The same card counts once in 1.5 seconds; another card's Got it always counts.
- **Save** (the header's Save, S, ⌘S) only saves; pressing S on a saved card changes nothing.
- **Delete** (the trash, D, the menu) and **Archive** (A, the menu) take the card out of the view at once, and the next card takes its place; **Unarchive** keeps it in view. Each offers Undo for 6 seconds ("Deleted “word”", "Archived “word”", "Unarchived “word”"), which puts the card back where it was.
- **Reset** (Shift+R, the menu) makes a reviewed card new again, with Undo ("Reset “word”"); on a card never reviewed it does nothing. A second press of Delete, Archive or Reset within 0.7 seconds is ignored, and so are Got it, Delete, Archive and Reset within 0.7 seconds of Unarchive, whose place in the header Got it takes.
- **Refresh with AI** works as in 3.6.

### 5.5 Reading by touch, the slideshow and example auto-play

- **Reading by touch.** On a touch screen, a tap in the top quarter of the screen reads example 1, in the second quarter example 2; marks on both edges show the bands. A second tap pauses or resumes, and past 85% starts again. A double tap leaves playback as it was before the first tap, and a tap that stops a scroll only stops it.
- **The playback cluster** at the bottom right holds Clear | Casual, voice speed, Duration (5 to 25 minutes, default 20), the slideshow and example auto-play. It steps aside while an example is open over the card.
- **The slideshow** shows each card for 1, 1.5, 2 (default), 3 or 5 seconds (+ or = changes it), meaning by meaning, then word by word, saying each word. Any manual move stops it.
- **Example auto-play** reads each card's first two examples (on a phrase card, the phrase) ×1 to ×5 (default ×3), with a gap of 2, 3, 5 or 10 seconds (default 2) between reads and 600 ms between cards. It ends after the last card, when Duration runs out (letting the read under way finish), or once it has stayed paused for 15 minutes. Anything else that speaks stops it; E pauses or resumes it, and Space stops it.
- While either runs, the screen stays awake (a pause keeps it awake for 2 minutes only) and the lock screen shows the word. Duration, repeats, gap and slide time are kept on the device, as Clear/Casual and speed are: each card view opens with the ones last chosen, and a word card shares them with a sentence opened from it.

### 5.6 Gestures and keys

**Touch:** swipe left for the next meaning (wrapping from the last to the first; on a one-meaning card it says the word); swipe right for the previous meaning, or out of the view from the first. Swipe up from the bottom of the card (or anywhere on a card that fits) for the next word, down from the top for the previous one; a short pull at the top shows the header. A double tap on blank space is Got it; buttons, links and green words don't count. **Trackpad:** a two-finger sideways swipe pages the meanings.

| Key | Action |
|---|---|
| ← → | Previous or next meaning (→ wraps; ← stops at the first) |
| ↑ ↓ | Previous or next word |
| R | Got it |
| Shift+R | Reset memory strength |
| S, ⌘S | Save the card |
| D | Delete the card |
| A | Archive or unarchive |
| P | Say the word |
| E | Read the first two examples. Again: pause or resume, or past 85% start again. During example auto-play: pause or resume it |
| ⌘1-4 | Read example 1-4 |
| Space | During example auto-play, stop it. Otherwise pause or resume a playing sentence, or start or stop the slideshow |
| + = | Change the slideshow's time per slide |
| H | Show or hide the header |
| Esc | Close the ⋮ menu, then the card |

Held letters act once and held arrows repeat. With ⌘, Ctrl or Alt held, letter keys go to the browser (⌘R reloads). A sheet or dialog on top of the card takes the keys.

### 5.7 Phrase cards

Older versions of the app saved some lookups as phrase items; today every lookup saves each meaning as a word card, multi-word expressions included. A phrase card shows its picture, its translation as the title, the phrase and its pronunciation, PlayPhrase and ChatGPT links, grammar notes, and "Key Vocabulary": a full word card for each word. A Key Vocabulary card's save button toggles (on a saved word it deletes that word's card, with Undo), and its × removes the word from the phrase, with Undo ("Removed “word”"), which puts it back where it was.

## 6. Sentence lessons

A sentence lesson is the card view for sentences: saved sentences, Real Life lines, essay sentences and the examples on word cards.

### 6.1 Opening

- **Where it opens:** a row on the Sentences tab, a line in a Real Life collection or a sentence in an essay (the lesson walks that list in its on-screen order, from the tapped sentence); a collection's or essay's Study button; the search box's saved-sentence suggestions; and "Open sentence review" on a word card (over the card) or under a study answer.
- Each sentence is paired with its source card, the word it came from; P and ⌘1-4 act on that card.
- An unsaved example opened from a word card or under a study answer is a preview: it has no review pill, Reset, Delete or picture button, and its right-hand button is "Save sentence". One opened under a study answer shows no pill after it is saved either.

### 6.2 The sentence page

- **Header:** Back ("Sentences", "Real Life", "Essays" or "Word"); the analysis button, a spinner while the analysis loads; "i / N"; and a pill. Amber "K to review" counts the run's sentences never reviewed or due; it reads the same on every sentence, counts down as you mark them, and turns into a green "All reviewed" at zero.
- **The sentence:** the studied expression in indigo on a light background; saved words and saved phrases of up to six words in indigo with a dotted underline; unsaved uncommon terms in green with a dotted underline; every other word plain.
- **The connected-speech line.** Under the sentence, the analysis's natural American IPA in connected speech, shown even when it matches the dictionary form; screen readers call it "Natural American IPA (connected speech)". It isn't a word target, and a sentence without one shows no line.
- **Under it:** a speaker; Copy ("Copy sentence (to paste into Meta AI)"); and on a Mac a ⌘ chip that lights while ⌘ is held, when hovered words show a ring.
- **The picture**, when there is one, sits left of the sentence on wide screens and above it on phones. The front page has no translation; the analysis page does.
- **Bottom row:** once the sentence has a review, its memory (badge, review count, streak, "N memorized in this list", next review) and Reset; Delete, for saved sentences only; and at the right end Got it, always the same size so nothing moves (a preview shows "Save sentence"). Clear | Casual and the auto-play button float at the bottom right, and the attach-picture button sits above the search button.

### 6.3 Words in the sentence

The owner's design:

| | Phone | Laptop |
|---|---|---|
| Play from a word | Tap it with one finger | Click it |
| Look up a word | Two-finger tap: hold one finger anywhere and tap the word | ⌘-click (Ctrl-click) |
| Look up a phrase | Not yet | Select up to six words, then ⌘-click inside the selection |

- A look-up of a saved word or phrase opens its review popup (8.7); anything else goes to the search, which shows "From your sentence: …" above the meanings. A word whose first or last letter is accented ("touché!") is looked up whole.
- Every tap or click shows on the word at once: a light indigo pulse when it plays from the word, a stronger flash with a ring when it looks the word up.
- Playing from a word uses the sentence's own clip and voice, starting at that word (9.3); during auto-play it moves auto-play's clip to the word. Enter plays from the word the caret or selection is in.

### 6.4 Blank space, Got it and moving

- **A tap or click on blank space** (anything but a word or a control; the picture and the IPA line count as blank) plays or pauses the sentence, starts it again past 85%, and during auto-play pauses or resumes auto-play. It waits 320 ms to rule out a double tap.
- **Got it:** a double tap on blank space or on the words, a double-click on blank space, R, or the button. It records Good and shows "Remembered!" with the next review; the sentence stays on screen. On a Real Life or essay line, the first Got it creates the line's record. The same sentence counts once in 1.5 seconds.
- **Reset** (Shift+R) works as on word cards. **Delete** (D, or the trash) applies to saved sentences only; it acts at once and offers Undo. Real Life and essay lines can't be deleted.
- **Moving:** swipe up from the bottom of the page, or press ↓, for the next sentence; swipe down from the top, or press ↑, for the previous one. The new sentence opens at its top and is read aloud in its remembered voice; at the first or last sentence, the current one is read again. On a long sentence with a picture, the page scrolls to its end before a swipe moves on.
- **Pages:** a swipe left, →, or a two-finger trackpad swipe opens the analysis page; a swipe right or ← returns to the sentence, and a swipe right on the sentence page closes the lesson.
- **Esc** closes, in turn, the picture panel, the auto-play panel and the analysis page, then the lesson.
- Closing a lesson opened by tapping an essay sentence returns the essay to the last sentence the lesson showed, tinted for 1.5 seconds and, on a laptop, focused, so Enter reopens it.
- A saved sentence deleted on another device leaves the run; the sentence on screen stays unless it is the one deleted, and the lesson closes if it was the last.

### 6.5 The analysis page

- **Header:** "← Sentence", "Sentence analysis" with "i / N", and a compact Got it. Then the sentence, its "American IPA" (careful) and its "Natural American IPA (connected speech)" when the two differ.
- **Sections:**
  1. Chinese Translation.
  2. Is It American English and Why? Collapsible, with a badge ("Distinctly American", "Natural shared English" or "Not natural American English") and the evidence.
  3. Uncommon Words and Phrases. Each term has its IPA, Chinese, a search button, original meaning, synonyms, antonyms, usage examples and historical evolution.
  4. Daily English Pronunciation: spoken slowly, spoken quickly, careful speaker, fast-speech features, intonation and chunking, key difference.
  5. Grammar Analysis.
- Analyses and pictures come from a shared pool on the server, written by the Mac's enrichment cycle (section 14); the VPS never writes one. The lesson fetches the current sentence's and the next five's. While one loads: "Loading analysis…". On a failure: "Couldn’t load the analysis. It will retry automatically." (after 15 seconds, on reconnecting, or when the lesson moves). With none yet: "Not analyzed yet".
- Looking up a term keeps the analysis open under the search sheet.

### 6.6 Listening and auto-play

- Each saved sentence remembers its last Clear or Casual voice, and showing it switches to that voice; choosing a voice, or hearing the sentence to its end, records it. The speaker and E play, pause, resume, and restart past 85%.
- **Auto-play.** The round button starts it and opens its panel, "Auto-play": speed; Duration, 5 to 25 minutes (default 20); Repeats, ×1 to ×5 (default ×3); Interval, 2, 3, 5 or 10 seconds (default 2); and Stop auto-play. Each sentence is read Repeats times with the interval between reads, then the next. It ends after the last sentence, when Duration runs out (the read under way finishes, and paused time doesn't count), or once it has stayed paused for 15 minutes.
- **The lock.** While auto-play runs, Back reads "Auto-play" with a lock, and Esc, Back or a swipe right open the panel; Stop is the way out. A tap on the button toggles the panel, and a long press (half a second) opens it.
- **Pausing.** Anything else that speaks (a lookup, a popup, a word, a voice change) pauses auto-play: the button shows Play and the countdown stops, and one tap resumes by reading the interrupted sentence again. A blank-space tap, the speaker, E and Space pause or resume it at any moment, and a pause from the phone (a call, AirPods taken out) shows as paused too.
- It preloads the clips and pictures it can reach in the time left ("Preloading k/N"). The screen stays awake, and a pause lets it sleep after 2 minutes. The lock screen and AirPods play and pause it, and next and previous move between sentences.

### 6.7 Attaching a picture

Saved sentences and Real Life or essay lines can take a picture: tap the picture button for "Choose photo" or "Paste image", drag a picture in, double-tap the button to paste, or press ⌘V anywhere in the lesson. The picture is stored on the device and uploaded. Errors read "That doesn’t look like an image.", "Couldn’t attach that image. Try again." and "The clipboard does not contain an image."

### 6.8 Keys

| Key | Action |
|---|---|
| ↑ ↓ | Previous or next sentence, read aloud |
| ← → | Sentence or analysis page |
| Enter | Play from the selected word |
| E | Read the sentence. Again: pause or resume, or past 85% start again. During auto-play: pause or resume it |
| Space | Pause or resume; with nothing playing, start auto-play; during auto-play, pause or resume it |
| P | Say its word |
| ⌘1-4 | Read example 1-4 of its word |
| R | Got it (the sentence stays on screen) |
| Shift+R | Reset memory strength |
| D | Delete a saved sentence |
| Esc | Close a panel or the analysis page, then the sentence |

## 7. The reading tabs

### 7.1 What the three tabs share

- Every sentence is new (never reviewed), due, or memorized (reviewed and not due yet). Study never takes sentences; you review them on these tabs and in their lessons.
- Saved sentences, Real Life lines and essay sentences keep separate records: reviewing a Real Life line never changes a saved copy of the same text.
- **A sentence keeps its place in a list until it is memorized**, by the owner's design. On the Sentences tab the order follows memory strength, which only a review (Got it or Reviewed) changes, so listening never moves a sentence. Real Life and essays keep their catalog order. Lists also don't shift as time passes or as syncs land: their clock is re-read only when you open a collection, an essay or a sentence, change the filter or search on the Sentences tab or the theme, review chip or search in a Real Life collection, or come back to the tab or the app. An open lesson keeps the order it opened with.
- Reviewed buttons record Good. A double click records one review, and a second Reviewed press within half a second in the same list is ignored.

### 7.2 Sentences

- Your saved sentences, under "Sentences", "{N} saved" and an orange "{K} to review". Order: weakest memory strength first, ties to the newest saved. Filter chips: All, New, Due, Memorized.
- **Search** ("Search saved sentences…") covers the sentence and its source word, ignoring case, accents, curly quotes and dashes. Literal matches update as you type (sentences in which the typed words start words come first), typo-tolerant ones 200 ms after typing pauses, and a search overrides the chips. With no match: "No sentences match “…”" and "Press Enter to look it up with AI instead". Enter sends the text to the search (section 3): a sentence is scanned, a word looked up. Esc clears the box.
- **Rows:** a strip on the left (grey for a sentence never reviewed, red under 40%, amber from 40%, emerald from 70%); the sentence (tapping the studied phrase opens the row, a saved word opens its review popup, a green word looks it up); the source word (or "Saved sentence") and its sense; and, for a sentence not to review, when it comes due ("tomorrow", "in 3d"). A sentence to review is orange, with a green "Reviewed" button. The trash asks "Delete" or "Cancel" in place, then offers Undo.
- A tap on a row, or Space or Enter on a focused row, opens its lesson.

### 7.3 Real Life

Five collections ship with the app, 1,120 lines in all:

| Collection | Level | Themes | Lines |
|---|---|---|---|
| Career Conversations | C1 | 13 | 234 |
| Daily Shopping | B2–C1 | 14 | 252 |
| Executive Communication | C1–C2 | 13 | 234 |
| Restaurant Conversations | B2–C1 | 10 | 200 |
| Travel Conversations | B2–C1 | 10 | 200 |

- **Landing page:** a tile per collection with its level, themes, "N reviewed", "N% mastery", line count, and "N due · M new" (the due count in an orange pill) or "all reviewed".
- **A collection** shows its title and "18% mastery · 46/234 reviewed"; wider screens add a stats strip with the due count over "due · M new". Below are a search box, the review chips (All, New, Due, Memorized) and theme chips.
- **Study** takes the theme and search in view, due lines first, then new ones: "Study 12"; "Practice" when nothing in view is due or new (it then goes through every line in view); a disabled "Study" when nothing is in view.
- **Rows** come in catalog order. Each shows the line, its theme, "Saved" if it is also a saved sentence, a state pill (a check and its strength when memorized, an orange "Due", or a grey "New"), Reviewed unless it is memorized, and a speaker; a line started from the speaker keeps playing when the row scrolls away or a filter hides it.
- The first Esc clears the search and the next returns to the collections; Back returns to the landing page where you left it.

### 7.4 Essays

Five public-domain classics ship with the app:

| Essay | Author | Sentences |
|---|---|---|
| Self-Reliance | Ralph Waldo Emerson, 1841 | 504 |
| Corn-Pone Opinions | Mark Twain, 1923 | 97 |
| Of Our Spiritual Strivings | W. E. B. Du Bois, 1903 | 102 |
| Why I Wrote “The Yellow Wallpaper” | Charlotte Perkins Gilman, 1913 | 17 |
| How It Feels to Be Colored Me | Zora Neale Hurston, 1928 | 105 |

- **Private modern essays,** the owner's catalog, load from the server for the signed-in account. If they fail to load, the page says "The private modern collection is temporarily unavailable; the historical collection remains fully usable." with Try again, and retries by itself when the connection returns or the app comes back to the front.
- **Landing page:** two sections, "Historical classics" and "Modern American voices" (grouped by publication), with tiles like Real Life's. A "Continue reading" card shows the last essay you left unfinished, with "Sentence p of n".
- **The reader** shows the title, author, level, reading time and word count; a progress card (mastery, reviewed of total, and the due count over "due · M new"); and every body sentence as a button, underlined orange when due and emerald when memorized. A tap opens a lesson over the whole essay from that sentence. Study goes through the essay's due sentences, then its new ones ("Study N", or "Practice").
- An essay reopens at the sentence where you left it; the place is kept per account on this device, for up to eight essays, and a finished essay opens at its title. At the end of a modern essay from a publication with several, "Next: <title>" opens the next one. Esc or Back returns to the Essays page at its scroll position.

## 8. Study

### 8.1 Scheduling

- **FSRS v6** through ts-fsrs with its default weights: 90% desired retention, a 10-year maximum interval, 10-minute learning and relearning steps, short-term scheduling on, and no fuzz, so the same history always gives the same schedule.
- **Grades:** Again, Hard, Good, Easy. Got it outside a session records Good.
- The device shows the new schedule at once. The server applies the same review to its stored schedule in one transaction, and its result is what every device keeps (11.3).
- Cards from the old fixed schedule become FSRS cards at their next review. Memory strength (section 1) shows on badges and picks the prompt type; it doesn't schedule anything.

### 8.2 What Study takes

Saved words and phrases that aren't archived, each meaning on its own schedule; sentences are never in Study. A session takes up to 40 due cards, most overdue first, then up to 10 new cards, oldest saved first, with one meaning per spelling.

### 8.3 The dashboard

- **"Today's Study"** shows Ready (the session's size), Due (due spellings) and Avg strength.
- **The Start button** reads "Review 50" over a line such as "40 due · 10 new · 70 more after this". When nothing is ready it is a disabled "All caught up", with "Next card due in 2h 10m · 34 by tomorrow" (by the coming midnight). Enter presses it on a laptop. A session takes the cards due when you press Start, and the counts stay current while the dashboard is open.
- **Weekly Stats (last 7 days):** Reviews, every review today and on the six days before; Recall (study), the share of study-session grades other than Again (Got it doesn't count; "—" when there are none); Day Streak, consecutive days with a review, counting back from today, or from yesterday when today has none yet.
- **7-Day Activity:** a bar chart over the same days, with "Total: N reviews" and "Avg: N/day". **Mastery Breakdown:** the cards by memory label.
- **Achievements:** Best card streak (the longest current run of non-Again grades on one card), Total Reviews, and Most Practiced (up to three reviewed cards with the most reviews).
- The review-history numbers read "—" until the history loads, and after an offline start they fill in once you're back online. With nothing saved, the tab shows "Your Study Space".

### 8.4 A session

- **The header** shows "i / n" (n grows when a card comes back), the prompt's instruction and × to end.
- **The prompt** depends on the card's memory strength:

| Strength | Prompt |
|---|---|
| Under 30, which includes every new card | "Recall the meaning": the word with its pronunciation. A spelling with several study cards adds a hint such as "noun · one of 3 meanings" |
| 30 to 54 | Alternates "Type the English word" (the Chinese and the English definition, with the word and its forms blanked) and "Recall the meaning" |
| 55 and up | Alternates "Fill in the blank" (an example with the word blanked) and "Listen to the sentence"; with no usable example, "Type the English word" |

- Fill-in-the-blank and listening prompts take turns through the card's examples.
- **Listening:** the sentence plays as the card appears (the first one inside the Start press). The 64 px dark button pauses, resumes or replays it, and it plays again on Resume or when you come back to the tab. The next three listening clips download ahead.
- **Typing:** the box doesn't capitalize or autocorrect. Enter reveals; in an empty box, Space reveals and ⌘Z undoes the last rating. After the reveal a verdict shows, which never grades: "✓ walk", "≈ wlak — one letter off" (no slip allowed under 4 letters, one for 4-7 letters, two for 8 or more), "↔ stroll is a synonym — this card is walk", or "✗ run".
- **Show answer** (Space or Enter) reveals the word, its pronunciation (tap to hear), the sense label, the Chinese and the definition; the example, with its own speaker and "Open sentence review"; and "Open card", which opens the full card over the session (a Got it there counts, and the session moves past that card). Revealing says the word unless audio is already playing.

### 8.5 Grades, the receipt and undo

- **The grades** are four buttons in one row (Again, Hard, Good, Easy; keys 1-4), each showing its next interval, in the slot where Show answer was. A tap within 350 ms of the reveal or of a grade is ignored.
- A grade whose interval is under a day brings the card back at the end of the session: Again (10 minutes), and Hard on a new or relearning card (15 minutes). A card reviewed elsewhere since the session began (in the popup, the card view or on another device), deleted or archived is skipped. Time away from a prompt counts at most two minutes toward the review.
- **The receipt line** above the grades names the last grade, for example "↶ walk · Good · next in 2d". It says "again later this session" when the card will come back, shows "Undoing…" during an undo, and adds "· saved on this device" while the grade waits to reach the server.
- **Undo** (U, or the line's button) goes back one grade only, to the card, revealed. It needs the grade to have reached the server first ("This review is still syncing. Try undo again."). A failed undo says why, in the line for 4 seconds or on the summary: "This card changed since, so the review can’t be undone." when a later change to the card superseded the review, "Reconnect to undo this review." offline, and otherwise "The review could not be undone." A grade, ending the session or an undo stops only audio the session started.

### 8.6 Ending, the summary and reloads

- × or Esc after at least one grade shows "Ended early · 23 of 50 reviewed" with Resume (R); before any grade it returns straight to the dashboard.
- **The summary:** "Session complete · 50 cards"; the count of each grade and "Recalled X of Y prompts."; "To look at again (N)", the words rated Again or Hard, each of which opens its card, with "Open these cards" to go through them in the card view; "Undo last rating"; and "Done" (Enter), back to the dashboard.
- A running session survives a reload, an update or iOS closing the app: for six hours after its last grade or move, it comes back at the card you were on, unrevealed, skipping cards reviewed elsewhere meanwhile. A session that ended early also comes back at its card.

| Key | Action |
|---|---|
| Enter | Start on the dashboard; Done on the summary |
| Space, Enter | Show the answer |
| 1-4 | Again, Hard, Good, Easy |
| U | Undo the last rating |
| P | Say the word, once the answer shows |
| E | Replay a listening prompt; once the answer shows, play or pause the example |
| Space, ⌘Z | In an empty answer box: show the answer, undo the last rating |
| Esc | Leave the answer box; then end the session early, or close the summary |
| R | Resume a session that ended early |

### 8.7 The review popup

- **It opens** from a saved word in a sentence: a dotted word on a Sentences or Real Life row, or the look-up gesture on a saved word or a selected saved phrase in a lesson.
- **It shows** every saved meaning of the spelling, archived ones included, opening on the one you tapped; after them, the word's other meanings from a fresh lookup (once per word per session), each marked "Not in your library yet" with "Save this meaning". The header holds the word, its sense, "‹ i/N ›", Clear/Casual, speed and close. A sideways swipe changes the meaning, and each change says the word.
- **A saved meaning's row** shows its memory (badge, review count, streak, next review), Reset, Delete (a first press turns it into "Sure?" for 2.5 seconds) and Got it. Confirmations show in a pill under the header for 1.6 seconds: "Next review in 32d", "Memory reset" ("Nothing to reset yet" on a meaning never reviewed), "Saved to your library".
- **Reading by touch:** on a phone, the card's outer edges read (the top quarter example 1, the second quarter example 2); on wider touch screens the gutters beside the card do. Selecting text and letting go over the dimmed area doesn't close the popup, and it closes by itself once every meaning it showed is deleted, here or on another device.
- **Keys:** ← → change the meaning; Space plays or pauses (the first example when nothing plays; a read still loading is left alone); P says the word; E reads the first two examples (again: pause or resume, or past 85% start again; one still loading is left alone); ⌘1-4 read example 1-4; R is Got it, or saves an unsaved meaning; Shift+R resets; D deletes (press again to confirm); Enter saves an unsaved meaning; Esc closes. Other ⌘ and Ctrl shortcuts stay the browser's (⌘R reloads, ⌘P prints), and held keys act once.

## 9. Audio

### 9.1 Voices

- **Sentences** (examples, saved sentences, Real Life lines and essay sentences) play the server's neural clips from MiMo-V2.5 TTS on DeepInfra, in one of two styles. **Clear** is a stock voice, "Mia": crisp and fully articulated. **Casual** is fast, reduced everyday speech: DeepSeek first respells the sentence with contractions and reductions ("gonna", "'em", "'cause"), keeping every content word, and a designed casual American voice reads the respelling. Until a sentence's casual clip exists, its Clear clip plays.
- **On a miss**, when the server has no clip yet, the app asks the server to make one for next time and meanwhile reads the sentence with **Kokoro**, an in-browser neural voice of about 330 MB, downloaded once and then usable offline. A laptop downloads it without asking; an Android phone asks first: "Download the natural voice? About 330 MB, one-time. After that it works offline with no further data." On iPhone and iPad, and wherever Kokoro is declined or can't run, the **system voice** reads instead.
- **Words** (the IPA chip, P, the word said when a card shows) always use the system voice, at once; Clear/Casual doesn't apply to them.
- **Settings:** speed for sentences is 1×, 1.1×, 1.3×, 1.5×, 1.75× or 2×. Style and speed are kept on the device and apply everywhere; set them in the Notebook's tools menu, on a card, in a lesson (speed sits in the auto-play panel) or in the review popup. Changing the style while a sentence plays or loads replays it from the start in the new voice; from the tools menu it only stops it.
- One player serves the whole app, so starting any sentence or word stops what was playing. The search sheet, the popup and a study session stop only audio they started.

### 9.2 Caching and warming

- The server caches each clip once, keyed by voice and text and shared by every user, along with its word timings. The device keeps clips too (up to 512 MB, never past 80% of its storage quota), so each downloads once and kept clips play offline.
- A fresh lookup, a Notebook AI result, a batch import and the Text Analyzer ask the server to make their examples' clips. A word card fetches the clips of its word and the words beside it, and a lesson prepares the current sentence and the next five.

### 9.3 Play from a word

The server times every word of every clip with whisper.cpp (its tiny English model). A tap on a word plays the sentence's clip from that word when its timings arrive within 400 ms; otherwise the system voice, or a loaded Kokoro, reads the rest of the sentence from that word. Playing from a word never starts the Kokoro download, and the server never makes a clip of the fragment.

### 9.4 Auto-play

Sentence lessons have auto-play (6.6); word cards have example auto-play and the slideshow (5.5).

### 9.5 Generate speech cache

The Notebook's "Generate speech cache" starts, or joins, the server's backfill, which makes clips and timings in both styles for the Real Life and essay catalogs, every example on every card and every saved sentence. A pill reads "Sentence audio · 1,200/7,000"; its × hides the pill while the server carries on. It ends with "Sentence audio ready · 120 new" or "Couldn’t start sentence audio" (with Retry), or says "Sentence audio continues on the server" when progress checks keep failing. The same backfill also runs every six hours from a GitHub workflow, and quietly after each batch import.

## 10. Notices, pills and undo

Notices are pills in one column at the bottom centre: above the tab bar on the tabs, higher over a card. They stack by how long they stay, top to bottom, so one coming or going doesn't move the others. Long text is cut off, or wraps where the pill allows it.

| Notice | What it says | When, and for how long |
|---|---|---|
| Undo | "Deleted “word”" with Undo | 6 seconds after a change that can be undone (below) |
| Search status | Section 3.3 | While the search reports |
| Preload | "Preloading k/N" | While auto-play preloads |
| Image pack, image restore | Section 4.9 | While they run; the result stays 3 seconds, or 6 on a failure |
| Sentence audio | Section 9.5 | While the backfill runs, then its result |
| Batch import | Section 4.8 | While it runs, then its result |
| Sync now | "Syncing…", then "Up to date" (2.5 seconds), or "Couldn’t sync" with Retry (6 seconds) | After Sync now |
| Merge duplicates | "No duplicates found" | 3 seconds |
| Can't save | Rose: "Couldn’t save on this device. Your changes still sync." Offline: "Couldn’t save on this device. Keep this tab open until you’re back online." | When saving to the device fails, until a save works; also over cards |
| Stuck sync | Amber: "3 changes not synced", with Retry | Online and visible, after two failed pushes in a row and a minute since the first |
| Offline | Amber: "Offline" | After 3 seconds without a connection, until it returns; on the tabs only |
| Refused changes | Amber: "1 change stays on this device: the server refused it" ("3 changes stay on this device: the server refused them") | While an item holds content the server refused (invalid, or too large), until it changes and is sent again |
| Refused reviews | Amber: "1 review wasn’t accepted", with View | Until viewed or dismissed (11.3) |
| Update | "Update ready" with Reload, or "Reload needed" | A new version waits until no card or popup is open; "Reload needed" (part of the app failed to load) shows at once |

- A background job shows one result pill at a time, each with ×; a new result replaces the one showing. Reload reads "Saving…" while it sends pending changes (for up to 10 seconds), then reloads.
- **What can be undone:** deleting, archiving and unarchiving a card; resetting a reviewed card (resetting a card never reviewed does nothing and offers nothing); Refresh with AI; removing a word from a phrase; and Clear all in the search results. Merging duplicates can't be undone.
- **How undo works:** one offer shows at a time, and a new one closes the old, whose change then goes through. Undo, or ⌘Z (Ctrl+Z elsewhere) while the pill shows, takes the change back; ⌘Z doesn't act in a text field, whose own undo wins, or while a decision dialog is open. An offered change is saved on the device at once but kept from the server until the pill closes, then pushed at once. Signing out or reloading closes the offer first.

## 11. Sync and offline

### 11.1 Where the library lives

- Each account's library lives on the server, in SQLite, and on each device, in IndexedDB, with one record per item; each web origin has its own device storage. The device saves changes 300 ms after they settle, and at once when the page is hidden or closed. Without IndexedDB (iOS private browsing) the library lives in memory and relies on the server's copy. The app asks the browser to keep its storage.
- Pictures travel separately: item data carries a marker, and each picture loads from its own server endpoint and is kept on the device (4.9).
- Fields only the server writes (the usage label, the enrichment markers, a saved sentence's analysis) survive a save made from an older copy, and the saving device shows them as soon as the save returns.

### 11.2 Launch, pulls and pushes

- **Launch:** the app reads the device's copy, then sends queued reviews, pulls changes and pushes local edits. A first visit takes a full copy, 500 items a page. If the device's copy can't be read: "Couldn’t open your library", with Try again, Reload app and Use the server copy (which may lose changes not yet synced).
- **Pulls:** while the app is visible and online, it pulls the server's changes since its last revision, 500 at a time, every 8 seconds, when the window gets focus or the page becomes visible, when the connection returns, and when another tab of the app has sent something.
- **Pushes:** 5 seconds after edits pause, and no later than 30 seconds into a steady stream of edits such as a study session, in batches of 200; deletes, archives, unarchives, resets, refreshes and removing a word from a phrase go at once, after their undo window. A failed push is retried after 8 seconds, then after longer waits up to 5 minutes, and at once when the connection returns. Two failures in a row and a minute without success bring up the stuck-sync pill. An item the server refuses (invalid, or too large) stays on the device, with the refused-changes pill, until it changes; Retry can't help it, so it doesn't count toward the stuck-sync pill.
- **Merging:** the server's revision numbers decide which copy is newer, and unsynced edits on the device survive a pull. A deletion wins unless the other copy is newer. A delete or archive made on the device applies on top of a server copy that changed meanwhile (an enrichment, for example). For schedules, the newer review wins. A copy stripped of its content never replaces a full one.

### 11.3 Reviews

- Each review is written first to an outbox on the device (localStorage, one entry per review), then sent to the server, which applies it in one transaction. The review's id makes retries safe: a review sent twice counts once. Its time is kept between the card's last review and five minutes past the server's clock.
- When the server refuses a review for good (for example, the card isn't on the server), the device drops it from the outbox, keeps the card's new schedule, which travels with the card, and shows the refused-reviews pill. View opens "Reviews the server refused": each word, when, and why ("The card isn’t on the server", "It clashed with a newer change"…), with Clear all. The user menu shows the count while any remain. A deleted Real Life or essay record comes back with its review instead of being refused.
- Undoing a review works only while it is still the card's latest change.

### 11.4 Offline

- The installed app opens without a connection, from its cache, with the saved session and the device's library. Reviews queue and edits are stored, and both go out once back online. Saved words and saved comparisons open in the search.
- New lookups and scans, the Text Analyzer, imports, the picture tools, Sync now, the speech cache and Sign out need a connection; they say so, or grey out with "Needs a connection".
- A service worker precaches the app. It looks for a new version when the app returns to the foreground (at most every 10 minutes), and a new version brings the update pill (section 10).

## 12. Accounts

- **One owner.** DictProp signs in with Google only and admits one person. With `OWNER_GOOGLE_EMAIL` set, only that address can sign in; its first sign-in on an empty database creates the admin account, and later sign-ins need that account. Anyone else gets a page saying "This DictProp instance is private. If it’s yours, sign in with the Google account that owns it.", with a Back to DictProp link; a request that doesn't accept HTML still gets the JSON error.
- **The sign-in screen** reads "DictProp", "AI-powered vocabulary learning" and "Sign in with Google". Offline, the button reads "Connect to sign in" and stays disabled until the connection returns.
- **Sessions:** an httpOnly cookie, whose token the server stores only as a hash. A session lasts 30 days, and using the app renews it once it has less than 23 days left, up to 180 days after you signed in. In practice you sign in again after three to four weeks away from the app, or every 180 days.
- **Expiry while the app is open:** the app keeps the library and any unsynced changes on the device and shows the sign-in screen with "Your sign-in expired. Your library and any changes not yet synced are kept on this device. Sign in to pick up where you left off." The lookups, comparisons and scans the expiry interrupted run again after you sign in (3.3).
- **Signing out** (the user menu in the Notebook header) asks "Sign out?" ("You'll need to be online to sign back in."), sends unsent changes first (for up to 10 seconds), then signs out and reloads. Offline it is greyed out; if the server can't be reached it says "Couldn't sign out", and you stay signed in.
- The library, the outbox, the refused-review log and the reading places are kept per account on each device. www.dictprop.online redirects to dictprop.online, so the sign-in cookie lives on one address.

## 13. The Gestures & shortcuts sheet

The sheet lists what each tap, swipe and key does. Its rows live in `services/shortcutSheet.ts`, where a change to a handler edits its row in the same commit, and a test pins the list.

- **Opening:** ? (except while typing); the tab bar's "?" button on screens 768 px wide or more; and the last row of the Notebook's ⋯ menu, "Gestures & shortcuts", on any screen, which is the only way in on a phone. Got it or Esc closes it.
- **Sections:** Touch, Navigation, Card view, Sentences, Study session, Word card popup, Search and Trackpad. Touch comes first on a touch screen and is left out elsewhere; keys show ⌘ on a Mac and Ctrl elsewhere.
- **The Navigation keys:**

| Key | Action |
|---|---|
| 1 2 3 | Notebook, Sentences, Study. Pressed again on their own tab: to the top, then (Notebook and Sentences) to the search box |
| ⌘F | Look up a word |
| ? | Show the sheet |
| Esc | Close what's on top, or go back; in the Notebook, clear the search; in an essay or a Real Life collection, back to its list (the first Esc clears the Real Life search) |
| ⌘Z | Undo, while the Undo pill shows |

The other sections' keys are in this document's tables: the card view (5.6), sentence lessons (6.8), Study (8.6), the review popup (8.7) and search (3.4).

## 14. Offline enrichment

**The split.** The VPS answers what a lookup needs at once: DeepSeek-V4-Flash on DeepInfra writes the cards, and MiMo-V2.5 voices the clips. It never draws pictures or writes detailed sentence analyses. Those, and a deeper rewrite of each new card, come from a cycle on the owner's Mac.

**The cycle** starts every six hours (a LaunchAgent) and runs only the code deployed from `main`. It reaches production only through GitHub, because the Mac can't connect to the VPS, and everything that crosses is encrypted (AES-256-GCM, each bundle bound to its operation), since the repository is public.

| Stage | What the user sees afterwards |
|---|---|
| Vocabulary | Up to 100 unarchived words and phrases per cycle: first cards saved in the past week that lack a field or the advanced rewrite, then older cards, only when they lack a field other than their examples. Each gets its missing fields filled and, once, an advanced rewrite of its learning content, recorded by a marker tied to a hash of the rewritten text. The rewrite includes the sense's usage label. On import, a sense labelled British only, Rare or dated, or Specialized (with medium or high confidence) is archived; an archive an earlier label caused is lifted when a later label rates the sense current, and archives you made stay. |
| Saved sentences | Every saved sentence without one gets its detailed analysis: the analysis page (6.5). |
| Pictures | Saved words, phrases and sentences get a picture when they have none, or when a card's rewrite has no matching picture yet. Krea-2-Turbo renders each candidate on the Mac at 1024×576, and the model judges it; a rejected candidate gets a refined prompt. After 8 rejected candidates the picture waits for a later cycle, which renders from new seeds. |
| Example sentences | The examples on cards get an analysis and a picture where production lacks them; this is what an example's lesson shows. |
| Off-site backup | About once a week, an encrypted copy of production's database and web-server configuration is kept on the Mac (ops/RESTORE.md). |

- **The model:** the text stages and the picture judge use Claude Opus 5.5 (`claude-opus-5-5` at `xhigh` effort) through Claude Code by default, or Codex when configured.
- **Getting into production:** production's library comes to the Mac as an encrypted workflow artifact. The results go back in waves, each an encrypted GitHub release asset that `sentence-backfill.yml` decrypts on a runner and streams to the VPS for import. An import skips any entry whose item changed after the export, so a later edit always wins, and a publisher waits while a deploy is queued or running.
- **The audit:** on the VPS side, `incremental-enrichment.yml` audits content coverage every six hours without generating anything, and fails, emailing the owner, when work the cycle should already have done is overdue.
- **Manual content:** the Real Life collections and the essay catalogs are made by hand with the manual tools in `scripts/offline/`, not by the cycle. Those tools can also render Real Life recordings with Qwen3-TTS, but the app doesn't play those voices. `scripts/offline/README.md` documents every stage and tool, and CLAUDE.md how to operate the bridge.
