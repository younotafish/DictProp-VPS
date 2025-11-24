/**
 * Study Task Components - Different difficulty levels for spaced repetition
 * 
 * Recognition: Easiest - see word, recognize meaning
 * Recall: Medium - see word, recall meaning
 * Listening: Audio-only recognition
 * Typing: Must produce the word from translation
 * Sentence: Use word in context
 */

import React, { useState, useEffect } from 'react';
import { VocabCard, SearchResult, TaskType } from '../types';
import { AudioButton } from './AudioButton';
import { PronunciationBlock } from './PronunciationBlock';
import { Check, X, Volume2 } from 'lucide-react';
import { Button } from './Button';

interface BaseTaskProps {
  onComplete: (quality: number, responseTime: number) => void;
  onSkip: () => void;
}

interface VocabTaskProps extends BaseTaskProps {
  vocab: VocabCard;
}

interface PhraseTaskProps extends BaseTaskProps {
  phrase: SearchResult;
}

// ========== RECOGNITION TASK ==========
// Show word + multiple choice meanings
export const RecognitionTask: React.FC<VocabTaskProps> = ({ vocab, onComplete, onSkip }) => {
  const [startTime] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Generate fake options
  const options = [
    vocab.chinese,
    'artificial option 1', // In real impl, pull from other vocab
    'artificial option 2',
    'artificial option 3',
  ].sort(() => Math.random() - 0.5);

  const correctIndex = options.indexOf(vocab.chinese);

  const handleSelect = (idx: number) => {
    setSelected(idx);
    setRevealed(true);
    
    const responseTime = Date.now() - startTime;
    const isCorrect = idx === correctIndex;
    
    setTimeout(() => {
      onComplete(isCorrect ? 5 : 0, responseTime);
    }, 1200);
  };

  return (
    <div className="flex flex-col h-full p-6 bg-white">
      <div className="mb-4">
        <span className="text-xs font-bold text-indigo-400 uppercase tracking-wide">Recognition</span>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center">
        <h1 className="text-4xl font-bold text-slate-800 mb-4">{vocab.word}</h1>
        
        <div className="mb-12">
            <PronunciationBlock 
                text={vocab.word}
                ipa={vocab.ipa}
                className="text-lg bg-slate-100 px-4 py-2 rounded-xl"
                showIcon={true}
            />
        </div>

        <div className="w-full max-w-md space-y-3">
          {options.map((opt, idx) => {
            const isCorrect = idx === correctIndex;
            const isSelected = selected === idx;
            
            let className = "w-full p-4 rounded-xl border-2 transition-all text-left font-medium";
            
            if (!revealed) {
              className += " border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 cursor-pointer";
            } else if (isSelected && isCorrect) {
              className += " border-emerald-500 bg-emerald-50 text-emerald-700";
            } else if (isSelected && !isCorrect) {
              className += " border-rose-500 bg-rose-50 text-rose-700";
            } else if (isCorrect) {
              className += " border-emerald-300 bg-emerald-50 text-emerald-700";
            } else {
              className += " border-slate-200 bg-slate-50 text-slate-400";
            }

            return (
              <button
                key={idx}
                className={className}
                onClick={() => !revealed && handleSelect(idx)}
                disabled={revealed}
              >
                <div className="flex items-center justify-between">
                  <span>{opt}</span>
                  {revealed && isCorrect && <Check size={20} className="text-emerald-600" />}
                  {revealed && isSelected && !isCorrect && <X size={20} className="text-rose-600" />}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Button variant="ghost" onClick={onSkip} className="mt-4 text-slate-400">
        Skip
      </Button>
    </div>
  );
};

// ========== RECALL TASK ==========
// Show word, user must recall meaning (then self-grade)
export const RecallTask: React.FC<VocabTaskProps> = ({ vocab, onComplete, onSkip }) => {
  const [startTime] = useState(Date.now());
  const [revealed, setRevealed] = useState(false);

  const handleReveal = () => {
    setRevealed(true);
  };

  const handleGrade = (quality: number) => {
    const responseTime = Date.now() - startTime;
    onComplete(quality, responseTime);
  };

  return (
    <div className="flex flex-col h-full p-6 bg-white">
      <div className="mb-4">
        <span className="text-xs font-bold text-blue-400 uppercase tracking-wide">Recall</span>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center">
        <h1 className="text-5xl font-bold text-slate-800 mb-6">{vocab.word}</h1>
        
        <div className="mb-12">
            <PronunciationBlock 
                text={vocab.word}
                ipa={vocab.ipa}
                className="text-xl bg-slate-100 px-6 py-3 rounded-2xl"
                showIcon={true}
            />
        </div>

        {!revealed ? (
          <Button onClick={handleReveal} className="px-8 py-4 text-lg">
            Show Answer
          </Button>
        ) : (
          <div className="w-full max-w-md space-y-6">
            <div className="p-6 bg-slate-50 rounded-2xl border-2 border-slate-200">
              <p className="text-2xl font-bold text-slate-800 mb-2">{vocab.chinese}</p>
              <p className="text-slate-600 leading-relaxed">{vocab.definition}</p>
              {vocab.examples.length > 0 && (
                <p className="mt-4 text-sm text-slate-500 italic">{vocab.examples[0]}</p>
              )}
            </div>

            <div className="pt-4">
              <p className="text-xs text-slate-500 mb-3 text-center font-medium">How well did you recall?</p>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handleGrade(0)}
                  className="p-3 bg-rose-100 text-rose-700 rounded-xl font-bold hover:bg-rose-200 transition-all"
                >
                  Forgot
                </button>
                <button
                  onClick={() => handleGrade(3)}
                  className="p-3 bg-amber-100 text-amber-700 rounded-xl font-bold hover:bg-amber-200 transition-all"
                >
                  Hard
                </button>
                <button
                  onClick={() => handleGrade(5)}
                  className="p-3 bg-emerald-100 text-emerald-700 rounded-xl font-bold hover:bg-emerald-200 transition-all"
                >
                  Easy
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {!revealed && (
        <Button variant="ghost" onClick={onSkip} className="mt-4 text-slate-400">
          Skip
        </Button>
      )}
    </div>
  );
};

// ========== TYPING TASK ==========
// Show meaning, user must type the word
export const TypingTask: React.FC<VocabTaskProps> = ({ vocab, onComplete, onSkip }) => {
  const [startTime] = useState(Date.now());
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);

  const handleSubmit = () => {
    const responseTime = Date.now() - startTime;
    const correct = input.trim().toLowerCase() === vocab.word.toLowerCase();
    setIsCorrect(correct);
    setSubmitted(true);

    setTimeout(() => {
      // Partial credit for close answers
      let quality = 0;
      if (correct) {
        quality = 5;
      } else if (input.trim().toLowerCase().includes(vocab.word.toLowerCase().substring(0, 3))) {
        quality = 2; // Partial recall
      }
      onComplete(quality, responseTime);
    }, 1500);
  };

  return (
    <div className="flex flex-col h-full p-6 bg-white">
      <div className="mb-4">
        <span className="text-xs font-bold text-purple-400 uppercase tracking-wide">Typing Challenge</span>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center">
        <div className="w-full max-w-md space-y-6">
          <div className="p-6 bg-indigo-50 rounded-2xl border-2 border-indigo-200">
            <p className="text-xs text-indigo-400 font-bold uppercase mb-2">Translation</p>
            <p className="text-2xl font-bold text-slate-800">{vocab.chinese}</p>
          </div>

          {!submitted ? (
            <>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && input.trim() && handleSubmit()}
                placeholder="Type the English word..."
                className="w-full p-4 text-xl border-2 border-slate-300 rounded-xl focus:border-indigo-500 focus:outline-none"
                autoFocus
              />
              <Button
                onClick={handleSubmit}
                disabled={!input.trim()}
                className="w-full py-4 text-lg"
              >
                Submit
              </Button>
            </>
          ) : (
            <div className={`p-6 rounded-2xl border-2 ${isCorrect ? 'bg-emerald-50 border-emerald-500' : 'bg-rose-50 border-rose-500'}`}>
              <div className="flex items-center gap-3 mb-2">
                {isCorrect ? (
                  <Check size={24} className="text-emerald-600" />
                ) : (
                  <X size={24} className="text-rose-600" />
                )}
                <span className={`font-bold ${isCorrect ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {isCorrect ? 'Correct!' : 'Incorrect'}
                </span>
              </div>
              {!isCorrect && (
                <div className="mt-3">
                  <p className="text-sm text-slate-600 mb-1">Your answer: <span className="font-mono">{input}</span></p>
                  <p className="text-sm text-slate-600">Correct answer: <span className="font-mono font-bold">{vocab.word}</span></p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!submitted && (
        <Button variant="ghost" onClick={onSkip} className="mt-4 text-slate-400">
          Skip
        </Button>
      )}
    </div>
  );
};

// ========== LISTENING TASK ==========
// Audio-only, must recognize the word
export const ListeningTask: React.FC<VocabTaskProps> = ({ vocab, onComplete, onSkip }) => {
  const [startTime] = useState(Date.now());
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);
  const [playCount, setPlayCount] = useState(0);

  const handleSubmit = () => {
    const responseTime = Date.now() - startTime;
    const correct = input.trim().toLowerCase() === vocab.word.toLowerCase();
    setIsCorrect(correct);
    setSubmitted(true);

    setTimeout(() => {
      // Quality adjusted by play count (more plays = lower quality)
      let quality = correct ? 5 : 0;
      if (correct && playCount > 2) quality = 4;
      if (correct && playCount > 4) quality = 3;
      
      onComplete(quality, responseTime);
    }, 1500);
  };

  return (
    <div className="flex flex-col h-full p-6 bg-white">
      <div className="mb-4">
        <span className="text-xs font-bold text-teal-400 uppercase tracking-wide">Listening</span>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center">
            <Volume2 size={64} className="text-slate-300 mb-6" />
            <p className="text-slate-500 mb-8 text-center">Listen and type what you hear</p>
            
            <AudioButton
              text={vocab.word}
              className="w-20 h-20 bg-teal-500 text-white rounded-full hover:bg-teal-600 shadow-lg"
              iconSize={36}
              onClick={() => setPlayCount(c => c + 1)}
            />
            
            {playCount > 0 && (
              <p className="text-xs text-slate-400 mt-2">Played {playCount}x</p>
            )}
          </div>

          {!submitted ? (
            <>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && input.trim() && handleSubmit()}
                placeholder="Type what you heard..."
                className="w-full p-4 text-xl border-2 border-slate-300 rounded-xl focus:border-teal-500 focus:outline-none"
                autoFocus
              />
              <Button
                onClick={handleSubmit}
                disabled={!input.trim()}
                className="w-full py-4 text-lg"
              >
                Check Answer
              </Button>
            </>
          ) : (
            <div className={`p-6 rounded-2xl border-2 ${isCorrect ? 'bg-emerald-50 border-emerald-500' : 'bg-rose-50 border-rose-500'}`}>
              <div className="flex items-center gap-3 mb-3">
                {isCorrect ? (
                  <Check size={24} className="text-emerald-600" />
                ) : (
                  <X size={24} className="text-rose-600" />
                )}
                <span className={`font-bold text-lg ${isCorrect ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {isCorrect ? 'Perfect!' : 'Not quite'}
                </span>
              </div>
              <div className="space-y-2">
                <p className="text-slate-600">
                  <span className="text-xs uppercase font-bold text-slate-400">You heard:</span><br />
                  <span className="font-mono text-lg">{input}</span>
                </p>
                {!isCorrect && (
                  <p className="text-slate-600">
                    <span className="text-xs uppercase font-bold text-slate-400">Correct word:</span><br />
                    <span className="font-mono text-lg font-bold">{vocab.word}</span>
                  </p>
                )}
                <p className="text-sm text-slate-500 mt-3">{vocab.chinese}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {!submitted && (
        <Button variant="ghost" onClick={onSkip} className="mt-4 text-slate-400">
          Skip
        </Button>
      )}
    </div>
  );
};

// ========== SENTENCE TASK ==========
// Use word in a sentence (self-graded)
export const SentenceTask: React.FC<VocabTaskProps> = ({ vocab, onComplete, onSkip }) => {
  const [startTime] = useState(Date.now());
  const [revealed, setRevealed] = useState(false);

  const handleReveal = () => {
    setRevealed(true);
  };

  const handleGrade = (quality: number) => {
    const responseTime = Date.now() - startTime;
    onComplete(quality, responseTime);
  };

  return (
    <div className="flex flex-col h-full p-6 bg-white">
      <div className="mb-4">
        <span className="text-xs font-bold text-orange-400 uppercase tracking-wide">Sentence Usage</span>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center">
        <div className="w-full max-w-md space-y-6">
          <div className="p-6 bg-gradient-to-br from-orange-50 to-amber-50 rounded-2xl border-2 border-orange-200">
            <p className="text-xs text-orange-400 font-bold uppercase mb-2">Word</p>
            <h1 className="text-3xl font-bold text-slate-800 mb-2">{vocab.word}</h1>
            <p className="text-slate-600">{vocab.chinese}</p>
          </div>

          <div className="p-6 bg-slate-50 rounded-2xl border-2 border-slate-200">
            <p className="text-xs text-slate-400 font-bold uppercase mb-3">Challenge</p>
            <p className="text-slate-700 leading-relaxed">
              Try to create a sentence using this word. Think about the context and usage.
            </p>
          </div>

          {!revealed ? (
            <Button onClick={handleReveal} className="w-full py-4 text-lg">
              Show Example
            </Button>
          ) : (
            <div className="space-y-6">
              <div className="p-6 bg-indigo-50 rounded-2xl border-2 border-indigo-200">
                <p className="text-xs text-indigo-400 font-bold uppercase mb-2">Example Sentence</p>
                <p className="text-slate-700 italic leading-relaxed">
                  {vocab.examples[0] || `The word "${vocab.word}" can be used in various contexts.`}
                </p>
              </div>

              <div>
                <p className="text-xs text-slate-500 mb-3 text-center font-medium">
                  Could you use it in a sentence?
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => handleGrade(1)}
                    className="p-3 bg-rose-100 text-rose-700 rounded-xl font-bold hover:bg-rose-200 transition-all text-sm"
                  >
                    Not Really
                  </button>
                  <button
                    onClick={() => handleGrade(3)}
                    className="p-3 bg-amber-100 text-amber-700 rounded-xl font-bold hover:bg-amber-200 transition-all text-sm"
                  >
                    Maybe
                  </button>
                  <button
                    onClick={() => handleGrade(5)}
                    className="p-3 bg-emerald-100 text-emerald-700 rounded-xl font-bold hover:bg-emerald-200 transition-all text-sm"
                  >
                    Yes!
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {!revealed && (
        <Button variant="ghost" onClick={onSkip} className="mt-4 text-slate-400">
          Skip
        </Button>
      )}
    </div>
  );
};

