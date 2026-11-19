// The themes Today groups the learner's own saved sentences into: a closed list of real-life scenes in domains. The
// server's classifier (server/src/themes) assigns each sentence one theme id; the client plans sets from those ids
// (services/learningLoop). Ids are stable and never reused: a renamed scene keeps its id, and a scene that is split
// or retired gets new ids while its old one is dropped, so a client that doesn't know an id treats the sentence as
// unsorted. Bump THEME_TAXONOMY_VERSION when the list changes; the server's sweep then sorts every sentence again, since
// the scenes' boundaries may have moved, and each device fetches its theme rows afresh.
// The classifier's boundary notes, which only its prompt needs, live in server/src/themes/boundaries.ts.

export const THEME_TAXONOMY_VERSION = 1;

export interface ThemeInfo {
  id: string;
  title: string;
  emoji: string;
  /** The situation, in a phrase. */
  blurb: string;
  /** The id of the domain it belongs to. */
  domain: string;
}

export interface ThemeDomain {
  id: string;
  title: string;
  emoji: string;
  themes: readonly ThemeInfo[];
}

type SceneRow = readonly [id: string, title: string, emoji: string, blurb: string];
type DomainRow = readonly [id: string, title: string, emoji: string, scenes: readonly SceneRow[]];

// 129 scenes in 17 domains, designed from a sample of the library (three independent proposals, a synthesis, a blind
// two-classifier test on a 400-item holdout at 93% agreement, then a refinement that merged the scenes they confused).
const DOMAIN_ROWS: readonly DomainRow[] = [
  ['food', 'Food and drink', '🍽️', [
    ['cooking-at-home', 'Cooking at home', '🍳', 'Prepping and cooking in your own kitchen: tools, cuts and techniques'],
    ['grocery-shopping', 'Grocery shopping', '🛒', 'Produce, herbs, cheese, deli counters, condiments and pantry staples'],
    ['tastes-and-appetites', 'Tastes and appetites', '😋', 'How food tastes, feels and smells, and how much you can eat'],
    ['eating-out', 'Eating out', '🍴', 'Restaurants and cafes: reservations, waits, tables, ordering and the check'],
    ['dishes-and-cuisines', 'Dishes and cuisines', '🌮', 'Named dishes from Mexican, Japanese, Italian and American diner menus'],
    ['baking-and-sweets', 'Baking and sweets', '🧁', 'Bread, pies, pastries, dough, candy and chocolate'],
    ['drinks-and-nightlife', 'Drinks and nightlife', '🍸', 'Wine, bars, clubs and raves; getting drunk or high'],
  ]],
  ['home', 'Home life', '🏠', [
    ['fixing-things-at-home', 'Fixing things at home', '🔧', 'DIY repairs, tools, wiring and plumbing, damage, pests and things that break'],
    ['renovating-and-decorating', 'Renovating and decorating', '🛋️', 'Remodels, contractors, furniture, linens and decor'],
    ['cleaning-and-laundry', 'Cleaning and laundry', '🧹', 'Chores, dirt, mold, messes, stains and doing the wash'],
    ['plants-and-gardening', 'Plants and gardening', '🌱', 'Houseplants, flowers, trees, lawns and yard work'],
    ['sleep-and-downtime', 'Sleep and downtime', '😴', 'Bedtime, waking up, feeling tired, lounging, unwinding and time alone'],
    ['houses-and-apartments', 'Houses and apartments', '🏡', 'Kinds of homes, rooms, doors and keys, renting and buying a place'],
    ['storing-and-stocking-up', 'Storing and stocking up', '📦', 'Containers, leftovers, food going bad, stocking up and running out'],
    ['living-with-pets', 'Living with pets', '🐕', 'Dogs, cats, pet sitters, shedding and strays'],
  ]],
  ['social', 'Family and social life', '👪', [
    ['family-and-kids', 'Family and kids', '👶', 'Relatives, pregnancy, babies, raising kids, babysitting and family ties'],
    ['dating-and-marriage', 'Dating and marriage', '💞', 'Crushes, flings, breakups, toxic relationships and married life'],
    ['sex-and-intimacy', 'Sex and intimacy', '🔞', 'Desire, sex, nudity and reproduction, said plainly or politely'],
    ['friends-and-falling-out', 'Friends and falling out', '🫂', 'Hanging out, loyalty, bailing, betrayal, feuds and making up'],
    ['parties-and-celebrations', 'Parties and celebrations', '🎉', 'Throwing or crashing parties, weddings, holidays, gifts and toasts'],
    ['fitting-in-and-groups', 'Fitting in and groups', '👥', 'Belonging, being left out or singled out, and switching sides'],
    ['supporting-someone', 'Supporting someone', '🤗', 'Comforting, encouraging, advising and looking after people'],
    ['courtesy-and-small-talk', 'Courtesy and small talk', '🙏', 'Polite requests, chitchat, etiquette and what\'s appropriate'],
  ]],
  ['health', 'Health and body', '🏥', [
    ['feeling-sick', 'Feeling sick', '🤒', 'Everyday symptoms, aches, sunburn, home remedies and getting better'],
    ['at-the-doctors', 'At the doctor\'s', '🩺', 'Checkups, tests, diagnoses, treatments, medicine, dentists and specialists'],
    ['serious-illness-and-death', 'Serious illness and death', '🥀', 'Grave diagnoses, chronic disorders, disability, dying, funerals and grief'],
    ['injuries-and-emergencies', 'Injuries and emergencies', '🚑', 'Falls, scrapes, fainting, drowning, poisoning and paramedics'],
    ['body-parts-and-functions', 'Body parts and functions', '🫀', 'Organs, bones and what bodies do: yawning, belching, digesting, senses'],
    ['working-out', 'Working out', '🏋️', 'Gym exercises, strength, training plans, diets, bulking and getting shredded'],
    ['mental-health', 'Mental health', '🧠', 'Therapy, trauma, conditions, neurodiversity, addiction and kicking habits'],
  ]],
  ['style', 'Clothes and grooming', '👗', [
    ['clothes-and-outfits', 'Clothes and outfits', '👕', 'Garments, fit and sizes, trying things on and putting a look together'],
    ['shoes-and-accessories', 'Shoes and accessories', '👜', 'Shoes, bags, jewelry, gems, scarves and hats'],
    ['sewing-and-fabrics', 'Sewing and fabrics', '🧵', 'Fabrics, leather, sewing, tailoring, knitting and embroidery'],
    ['hair-skin-and-grooming', 'Hair, skin and grooming', '💇', 'Haircuts, braids, wigs, skincare, nails and washing up'],
  ]],
  ['work', 'Work and money', '💼', [
    ['office-life', 'Office life', '🏢', 'Coworkers, cubicles, shifts, workload, time off and team outings'],
    ['bosses-and-office-politics', 'Bosses and office politics', '👔', 'Managers, leading a team, sucking up and grudges between teams'],
    ['in-a-meeting', 'In a meeting', '📊', 'Proposing, pushing back, presenting, summing up and moving meetings around'],
    ['running-a-project', 'Running a project', '🗂️', 'Rollouts, handoffs, delays, overruns and starting from scratch'],
    ['job-hunting-and-careers', 'Job hunting and careers', '🪜', 'Applying, interviews, promotions, mentors and career paths'],
    ['running-a-business', 'Running a business', '🏪', 'Startups, clients, strategy, budget cuts, breaking even and shipping'],
    ['sales-and-marketing', 'Sales and marketing', '📣', 'Selling, prospects, target markets, product lines and undercutting'],
    ['factories-and-construction', 'Factories and construction', '🏗️', 'Building sites, machines, mines, oil rigs and what things are made of'],
    ['spending-and-saving', 'Spending and saving', '💰', 'Prices, bargains, splurges, budgets and frugal living'],
    ['bills-loans-and-debt', 'Bills, loans and debt', '💳', 'Your bills, taxes, borrowing, credit, repaying and scraping money together'],
    ['markets-and-the-economy', 'Markets and the economy', '📉', 'Stocks, dividends, trading, recessions and jobs'],
    ['rich-and-poor', 'Rich and poor', '💎', 'Wealth, class, luxury, privilege, poverty and new money'],
  ]],
  ['errands', 'Out and about', '🧭', [
    ['at-the-store', 'At the store', '🛍️', 'Asking staff about products, stock, models, special orders and fees'],
    ['driving-and-traffic', 'Driving and traffic', '🚗', 'Cars, bikes, roads, rides, tolls, traffic jams, parking and fender benders'],
    ['around-town', 'Around town', '🏙️', 'Streets, corners, transit, neighborhoods and city infrastructure'],
    ['flying', 'Flying', '✈️', 'Fares, carry-ons, delays, layovers, takeoff, landing and hangars'],
    ['trips-and-sightseeing', 'Trips and sightseeing', '🗺️', 'Getaways, tours, hotels, landmarks and souvenirs'],
    ['describing-a-place', 'Describing a place', '🌅', 'Saying a spot is cozy, cramped, tranquil, buzzing, seedy or a dump'],
  ]],
  ['nature', 'Nature and outdoors', '🌲', [
    ['weather-and-temperature', 'Weather and temperature', '☔', 'Rain, heat waves, cold snaps, sun and shade, dusk and getting drenched'],
    ['landscapes-and-terrain', 'Landscapes and terrain', '🏞️', 'Tundra, savanna, marshes, cliffs, coves, rocks and scenery'],
    ['watching-wildlife', 'Watching wildlife', '🦁', 'Wild animals, birds, insects and sea life, and how they behave'],
    ['farms-and-the-countryside', 'Farms and the countryside', '🚜', 'Ranches, livestock, crops, orchards and harvest time, in any era'],
    ['fires-and-disasters', 'Fires and disasters', '🔥', 'Wildfires, earthquakes, lava, smoke, evacuations and rubble'],
    ['hiking-and-camping', 'Hiking and camping', '🏕️', 'Trails, tents, treks, campsites and getting stranded'],
    ['on-the-water', 'On the water', '⛵', 'Boats, kayaks, fishing, swimming, rivers, tides and rough seas'],
  ]],
  ['fun', 'Fun and the arts', '🎭', [
    ['movies-tv-and-theater', 'Movies, TV and theater', '🎬', 'Films, shows, actors, plays, ovations, circus and magic acts'],
    ['books-and-poetry', 'Books and poetry', '📚', 'Novels, memoirs, plots, characters, cliffhangers, sonnets and rhymes'],
    ['music-and-dance', 'Music and dance', '🎵', 'Songs, records, instruments, singers, orchestras, dancing and sound gear'],
    ['art-and-museums', 'Art and museums', '🖼️', 'Galleries, painting, sculpture, photography, exhibits and art movements'],
    ['jokes-and-laughter', 'Jokes and laughter', '😂', 'Comedians, slapstick, banter, impressions and laughing till you can\'t breathe'],
    ['sports-talk', 'Sports talk', '🏈', 'Teams, players, games, gear, seats and scores, watching or playing'],
    ['games-toys-and-hobbies', 'Games, toys and hobbies', '🎲', 'Toys, playground games, fairs and rides, video games and collecting'],
    ['social-media-and-slang', 'Social media and slang', '📱', 'Influencers, posts, memes, clickbait, catfishing and Gen Z slang'],
  ]],
  ['science', 'Science and school', '🔬', [
    ['computers-and-phones', 'Computers and phones', '💻', 'Devices, apps, batteries, signal, logging in, malware, robots and VR'],
    ['space-and-astronomy', 'Space and astronomy', '🔭', 'Stars, galaxies, orbits, eclipses, rovers and Mars missions'],
    ['chemistry-and-physics', 'Chemistry and physics', '⚗️', 'Elements, radioactivity, forces, gears and how machines work'],
    ['biology', 'Biology', '🧬', 'Cells, genes, microbes, spores, embryos and how living things are built'],
    ['math-and-data', 'Math and data', '➗', 'Numbers, rates, probability, statistics, flukes and outliers'],
    ['school-and-college', 'School and college', '🎓', 'Classes, exams, grades, detention, lectures, professors and dropping out'],
    ['words-and-writing', 'Words and writing', '✍️', 'Spelling, grammar, handwriting, scripts, languages and wordiness'],
  ]],
  ['society', 'News and society', '🗞️', [
    ['news-and-media', 'News and media', '📰', 'Newscasts, anchors, headlines, tabloids and staying informed'],
    ['politics-and-government', 'Politics and government', '🗳️', 'Campaigns, recounts, coalitions, laws, councils, treaties and gridlock'],
    ['protests-and-unrest', 'Protests and unrest', '📢', 'Rallies, reformers, uprisings, rebels, riots and upheaval'],
    ['social-issues', 'Social issues', '✊', 'Inequality, discrimination, climate, polarization, wokeness and cancel culture'],
    ['power-and-control', 'Power and control', '⛓️', 'Regimes, dictators, coups, iron grips, autonomy and breaking free'],
    ['rules-and-red-tape', 'Rules and red tape', '📋', 'Permission, forms, permits, eligibility and getting away with it'],
    ['crime-and-police', 'Crime and police', '🚔', 'Crimes, fugitives, gangs, hard drugs, interrogations, wiretaps and spies'],
    ['courts-and-the-law', 'Courts and the law', '⚖️', 'Trials, testimony, juries, lawsuits, appeals, contracts and legal rights'],
    ['scams-and-taking-advantage', 'Scams and taking advantage', '🦊', 'Cons, forgeries, fine-print traps, crooks and freeloaders'],
    ['war-and-the-military', 'War and the military', '🎖️', 'Troops, militias, snipers, forts, retreats, armistices and the draft'],
    ['fights-and-weapons', 'Fights and weapons', '🥊', 'Brawls, aggression, guns, bows, spears and hunting'],
  ]],
  ['culture', 'History, culture and faith', '🏛️', [
    ['history-and-the-past', 'History and the past', '🏺', 'Ancient civilizations, ruins, historians, eras and frontiers'],
    ['kings-and-peasants', 'Kings and peasants', '👑', 'Monarchs, nobles, knights, jesters, castles and peasant life'],
    ['myths-and-legends', 'Myths and legends', '🐉', 'Ghosts, monsters, gods of myth, fairy tales, magic and superstitions'],
    ['religion-and-faith', 'Religion and faith', '🛐', 'Worship, pilgrimage, churches, sects, the sacred and leaving a faith'],
    ['places-peoples-and-names', 'Places, peoples and names', '📍', 'Cities, states, countries, nationalities, ethnic groups and names'],
  ]],
  ['people', 'Describing people', '🧑', [
    ['describing-personality', 'Describing personality', '😎', 'Temperaments, traits and quirks: pragmatic, easygoing, stodgy, a spark plug'],
    ['looks-and-body-language', 'Looks and body language', '🪞', 'Build, face, hair, gestures, glances and what body language gives away'],
    ['calling-out-bad-character', 'Calling out bad character', '🐍', 'Cruel, entitled, two-faced, a hog, a scoundrel, a creep'],
    ['right-and-wrong', 'Right and wrong', '😇', 'Morals, values and good deeds: heroes, altruists and decent people'],
    ['smarts-and-skills', 'Smarts and skills', '💡', 'Talent, expertise and cleverness, or armchair experts'],
    ['fame-and-reputation', 'Fame and reputation', '🌟', 'Who\'s famous, respected or a fixture, legacies and how things are received'],
  ]],
  ['feelings', 'Feelings and reactions', '💭', [
    ['losing-your-temper', 'Losing your temper', '😡', 'Anger, blowing up, storming off and telling people to knock it off'],
    ['stress-and-worry', 'Stress and worry', '😰', 'Nerves, fear, dread, impatience, fixating and fretting'],
    ['feeling-down', 'Feeling down', '😔', 'Sadness, disappointment, loneliness, crying, sulking and losing heart'],
    ['happy-and-excited', 'Happy and excited', '😄', 'Delight, enthusiasm, pride, hope and a heady rush'],
    ['hooked-or-bored', 'Hooked or bored', '🤩', 'What grabs you, what you can\'t stand, and what bores you'],
    ['reacting-to-news', 'Reacting to news', '😲', 'Shock, disbelief, disgust and sarcastic \'no kidding\' replies'],
    ['keeping-it-together', 'Keeping it together', '🧘', 'Staying calm, holding back tears, hiding or working through feelings'],
    ['mistakes-and-apologies', 'Mistakes and apologies', '😬', 'Slip-ups, oversights, cringe moments, regret, do-overs and saying sorry'],
  ]],
  ['talk', 'Talking and opinions', '💬', [
    ['how-people-talk', 'How people talk', '🗣️', 'Rambling, barking, mumbling, deadpan, crude talk and raising a topic'],
    ['honesty-lies-and-bs', 'Honesty, lies and BS', '🤥', 'Being frank or evasive, spinning, lying, faking, and calling out BS'],
    ['stories-and-memories', 'Stories and memories', '📖', 'Recounting what happened, anecdotes, tall tales, remembering and forgetting'],
    ['gossip-and-scandal', 'Gossip and scandal', '🤫', 'Rumors, secrets, leaks, whistleblowers and scandals that blow up'],
    ['arguing-a-point', 'Arguing a point', '🙋', 'Giving opinions, making a case, agreeing, disagreeing and conceding'],
    ['persuading-and-negotiating', 'Persuading and negotiating', '🤝', 'Talking someone around, pestering, pressuring, tempting, haggling and deals'],
    ['saying-no-or-backing-down', 'Saying no or backing down', '🙅', 'Refusing, rejecting, avoiding, standing firm or caving under pressure'],
    ['praising-or-panning', 'Praising or panning', '👍', 'Calling something superb, decent, gnarly, hideous, hollow or a stinker'],
    ['criticizing-and-insulting', 'Criticizing and insulting', '👎', 'Laying into someone, taking digs, sneering, griping, slamming and condemning'],
  ]],
  ['thinking', 'Thinking and doing', '🤔', [
    ['figuring-things-out', 'Figuring things out', '🧩', 'Understanding, explaining, guessing, and how sure you are'],
    ['making-decisions', 'Making decisions', '🪙', 'Weighing options, narrowing down, hesitating, committing and risk'],
    ['causes-and-effects', 'Causes and effects', '🔗', 'Why things happen, ripple effects, links and signs of what\'s coming'],
    ['comparing-and-sorting', 'Comparing and sorting', '🆚', 'Alike or different, typical or odd, ahead or behind, and sorting into groups'],
    ['what-matters-most', 'What matters most', '🎯', 'The crux, priorities and must-dos versus trifles and side issues'],
    ['problems-and-fixes', 'Problems and fixes', '🧰', 'Snags, hurdles, workarounds, stopgaps, chaos and averting disaster'],
    ['effort-and-grit', 'Effort and grit', '💪', 'Diving in, slogging away, toughing it out, sticking with it, or pulling out'],
    ['success-and-failure', 'Success and failure', '🏆', 'Winning, losing, flops, scraping by and going down in flames'],
    ['plans-and-timing', 'Plans and timing', '📅', 'Firming up plans, rushing, being late, how often, and time passing'],
    ['change-and-trends', 'Change and trends', '📈', 'Rising, dipping, fading, adapting, decaying, swinging back and new eras'],
  ]],
  ['describing', 'Describing things', '🔍', [
    ['size-and-amount', 'Size and amount', '📏', 'How big, heavy, many, much or very: colossal, hefty, legion, utterly'],
    ['shape-and-position', 'Shape and position', '📐', 'Crescents, rims, layers, gaps, and where things sit, lean or lie around'],
    ['colors-light-and-texture', 'Colors, light and texture', '🎨', 'Colors, glow, glitter, sheen, blur, patterns and the look of a design'],
    ['sounds-and-smells', 'Sounds and smells', '👂', 'Clatters, squeaky hinges, crisp audio, crowd noise and foul odors'],
    ['moving-around', 'Moving around', '🏃', 'Darting, staggering, swaying, bumping into things, going in and out'],
    ['handling-things', 'Handling things', '✋', 'Grabbing, letting go, cramming, twisting, unfurling and rummaging'],
  ]],
];

export const THEME_DOMAINS: readonly ThemeDomain[] = DOMAIN_ROWS.map(([id, title, emoji, scenes]) => ({
  id,
  title,
  emoji,
  themes: scenes.map(([themeId, themeTitle, themeEmoji, blurb]) => ({
    id: themeId, title: themeTitle, emoji: themeEmoji, blurb, domain: id,
  })),
}));

/** Every theme, in domain order. */
export const THEMES: readonly ThemeInfo[] = THEME_DOMAINS.flatMap(domain => domain.themes);

const THEMES_BY_ID = new Map(THEMES.map(theme => [theme.id, theme]));

export const themeById = (id: string): ThemeInfo | undefined => THEMES_BY_ID.get(id);

export const isThemeId = (value: unknown): value is string => typeof value === 'string' && THEMES_BY_ID.has(value);

/** GET /api/themes: the theme rows changed after the asked sequence number, and how the server's sorting stands. */
export interface ThemesResponse {
  taxonomyVersion: number;
  /** [itemId, themeId], in sequence order; a null theme means the item has none any more. */
  rows: Array<[string, string | null]>;
  /** The sequence number to ask after next time. */
  latestSeq: number;
  /** Items still waiting for a theme. */
  pending: number;
  status: 'idle' | 'running' | 'paused';
  /** Why the last sweep stopped early, when it did. */
  lastError?: string;
}
