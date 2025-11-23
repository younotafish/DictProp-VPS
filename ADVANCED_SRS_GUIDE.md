# Advanced SRS System Guide

## Overview

The upgraded study system implements a sophisticated spaced-repetition algorithm inspired by **SuperMemo** and **Shanbay (扇贝)**, featuring:

- 🧠 **Memory Strength Model** - Hidden metric tracking true retention (0-100)
- 📈 **Dynamic Intervals** - Adaptive review scheduling based on forgetting curves
- 🎯 **Multi-Task Learning** - Different study modes with varying difficulty
- ⏰ **Time Decay** - Automatic memory degradation simulation
- ☁️ **Firebase Sync** - Cloud backup of learning history and analytics

---

## Core Concepts

### 1. Memory Strength (记忆强度)

Every word has a **hidden memory strength** value (0-100) that represents your true retention level:

- **0-10**: New / Never studied
- **10-30**: Struggling / Needs practice
- **30-50**: Learning / Building foundation
- **50-70**: Proficient / Good retention
- **70-85**: Mastered / Strong memory
- **85-100**: Grandmaster / Permanent retention

This value is **hidden from you** during study to prevent gaming the system - the algorithm shows you words when you're most likely to benefit from review.

### 2. Dynamic Review Intervals

Unlike rigid Ebbinghaus intervals, this system adapts to **your actual performance**:

- **High memory strength** → Longer intervals (up to 180 days)
- **Low memory strength** → Shorter intervals (as low as 1 minute)
- **Failed reviews** → Immediate reset to short intervals
- **Consistent success** → Exponential interval growth

The algorithm uses **forgetting curves** to predict when you'll drop below 85% retention, scheduling reviews just before that point.

### 3. Task Difficulty Weighting

Different study modes provide different levels of mastery signals:

| Task Type | Difficulty | Strength Impact | Description |
|-----------|------------|-----------------|-------------|
| **Recognition** | ⭐ | 1.0× | See word → recognize meaning (multiple choice) |
| **Recall** | ⭐⭐ | 1.3× | See word → remember meaning (self-graded) |
| **Listening** | ⭐⭐⭐ | 1.5× | Hear word → type what you heard |
| **Typing** | ⭐⭐⭐⭐ | 1.8× | See meaning → type the word |
| **Sentence** | ⭐⭐⭐⭐⭐ | 2.0× | Use word in context (self-graded) |

**Harder tasks boost memory strength more**, so the system progressively challenges you as you improve.

### 4. Time Decay

When you don't review a word, its memory strength **automatically decays** over time:

```
Current Strength = Previous Strength × e^(-days_passed / stability)
```

- **High stability** → Slower decay
- **Low stability** → Faster decay
- Words naturally "bubble up" for review as their strength drops

### 5. Stability & Difficulty

**Stability** (稳定性): How long memories last before forgetting
- Increases with successful reviews
- Resets on failures
- Max: ~90 days

**Difficulty** (难度): Inherent hardness of each word
- Starts at 5/10 (medium)
- Adjusts based on your performance pattern
- Harder words get shorter intervals automatically

---

## How It Works: Step-by-Step

### When You Study a Word

1. **System calculates current memory strength** after time decay
2. **Recommends a task type** based on your mastery level
3. **You complete the task** (recognition, typing, etc.)
4. **Algorithm records:**
   - Quality of recall (0-5)
   - Response time
   - Task difficulty
5. **Memory strength updates:**
   ```
   New Strength = Decayed Strength + (Quality Impact × Task Weight) + Speed Bonus
   ```
6. **Stability adjusts:**
   - Excellent recall (4-5) → +80% stability
   - Good recall (3) → +40% stability
   - Failed (0-2) → -50% stability (reset)
7. **Next review calculated** using new strength + stability

### Quality Ratings

When you answer:

| Rating | Meaning | Strength Impact |
|--------|---------|-----------------|
| **0** | Complete fail | -25 points |
| **1** | Hard fail | -10 points |
| **2** | Barely remembered | -5 points |
| **3** | Good recall | +5 points |
| **4** | Very good | +12 points |
| **5** | Perfect / Easy | +20 points |

Impact is multiplied by task difficulty (e.g., typing a word correctly = +36 points vs. +20 for recognition).

### Response Time Bonus

Fast, confident responses get a small bonus:

- **< 50% of expected time**: +3 points
- **< 80% of expected time**: +1 point
- **> 200% of expected time**: -2 points

---

## Study Dashboard Features

### Statistics

- **Due Now**: Items below 85% retention probability
- **Mastery Levels**: Distribution across strength categories
- **Average Memory Strength**: Overall retention health
- **Streak**: Consecutive days with study sessions

### Smart Session Builder

The system builds study sessions by:

1. **Prioritizing items with lowest retention probability** (most at risk of forgetting)
2. **Backfilling with struggling items** if queue is small
3. **Mixing task types** based on individual word mastery
4. **Limiting sessions to ~10 items** for optimal focus

### Progress Tracking

After each session, you'll see:
- **Accuracy**: % of correct responses
- **Average response time**: Speed of recall
- **Memory strength changes**: Per-word improvements

---

## Firebase Integration

### What Gets Synced

1. **Learning History**: All SRS data including:
   - Memory strength values
   - Stability & difficulty metrics
   - Task performance records
   - Review timestamps

2. **Analytics Summary**:
   - Total reviews
   - Study time
   - Streak data
   - Performance by task type
   - Weak/strong words

3. **Daily Activity**:
   - Reviews per day
   - Study time per day
   - Accuracy trends

### Privacy

- All data is **private to your account**
- Memory strength is **never shared** with other users
- You can export/delete your data anytime

---

## Tips for Maximum Learning

### 1. **Study Consistently**
- Daily short sessions (10-15 min) > Rare long sessions
- Maintain your streak for better retention

### 2. **Trust the Algorithm**
- Don't skip "easy" words - the system knows when review is needed
- Failed reviews are learning opportunities, not setbacks

### 3. **Challenge Yourself**
- Embrace harder task types (typing, listening) for stronger memories
- Self-grade honestly - the system adapts to your truth

### 4. **Review the Dashboard**
- Check "Needs Practice" section for weak spots
- Celebrate "Grandmaster" words reaching permanent retention

### 5. **Respond Quickly**
- Faster recall = stronger memory encoding
- But don't guess - accuracy matters more than speed

---

## Advanced: Algorithm Details

### Interval Calculation

```typescript
// Target retention probability (85%)
const targetRetention = 0.85;

// Base interval in days
intervalDays = stability × ln(1 / targetRetention) × difficultyFactor;

// Strength multiplier
if (memoryStrength >= 80) intervalDays *= 2.5;
else if (memoryStrength >= 60) intervalDays *= 1.8;
else if (memoryStrength >= 40) intervalDays *= 1.3;
else if (memoryStrength < 20) intervalDays *= 0.4;

// Clamp: 1 minute to 180 days
intervalDays = Math.max(0.0007, Math.min(180, intervalDays));
```

### Retention Probability

At any moment, your retention probability is:

```typescript
currentStrength = memoryStrength × e^(-daysSinceReview / (stability × 2));
retentionProbability = currentStrength / 100;
```

The dashboard shows items with **retention < 85%** as "due".

---

## Migration from Old System

If you had items in the old SRS system, they were automatically migrated:

- **Old interval** → converted to stability (days)
- **Old ease factor** → used to estimate initial memory strength
- **Old history** → preserved, accuracy calculated
- **New fields** → initialized with smart defaults

No data was lost - the new system builds upon your existing progress!

---

## Comparison to Other Systems

### vs. Anki (SM-2)
- ✅ More adaptive intervals
- ✅ Multiple task types
- ✅ Time decay simulation
- ✅ Modern UI with analytics

### vs. Duolingo
- ✅ True spaced repetition (not XP-driven)
- ✅ Scientific forgetting curves
- ✅ Transparent algorithm (not a black box)

### vs. Shanbay (扇贝)
- ✅ Similar memory strength model
- ✅ Similar multi-task approach
- ✅ Open-source & customizable
- ✅ Firebase sync instead of proprietary cloud

---

## Troubleshooting

**Q: Why am I seeing words I just studied?**
- A: If you rated them as "failed" (0-2), they reset to short intervals. This is intentional for re-learning.

**Q: Why do some words have very long intervals?**
- A: High memory strength + high stability = the algorithm trusts your long-term retention. You can still practice them in "Practice Mode".

**Q: Can I see my memory strength values?**
- A: No - they're intentionally hidden to prevent gaming. Focus on honest self-assessment instead.

**Q: What if I disagree with the task type?**
- A: You can skip and move to the next item. The algorithm will adapt over time.

**Q: How do I reset a word's progress?**
- A: Currently not supported - but consistently rating it as "failed" will naturally reset intervals.

---

## Future Enhancements

Potential additions (not yet implemented):

- [ ] Leitner box visualization
- [ ] Heatmap calendar of study activity
- [ ] Goal setting & achievements
- [ ] Spaced repetition for example sentences
- [ ] AI-generated mnemonics based on memory strength
- [ ] Group study sessions with shared analytics

---

## Credits

Algorithm inspired by:
- SuperMemo SM-2 / SM-15+
- Shanbay (扇贝) memory strength model
- Research on forgetting curves (Ebbinghaus, Wozniak)

Built with ❤️ for effective learning.

