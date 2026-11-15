// Lines first, so a phrase with a comma in it ("easy come, easy go") stays whole: in a list of several
// lines, commas split a line only when it's a run of single words ("apple, pear"). Pasted as one line,
// the list splits at every comma. Semicolons always split.
export const parseWordList = (text: string): string[] => {
  const lines = text.split('\n').filter(line => line.trim());
  return lines
    .flatMap(line => line.split(';'))
    .flatMap(entry => {
      const parts = entry.split(',');
      return lines.length === 1 || parts.every(part => !/\s/.test(part.trim())) ? parts : [entry];
    })
    .map(w => w.trim())
    .filter(w => w.length > 0);
};
