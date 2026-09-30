import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

const grammarMarkdownComponents: Components = {
  strong: ({ node: _node, ...props }) => <span className="font-bold text-indigo-700 bg-indigo-50 px-1 rounded" {...props} />,
};

/** A phrase's grammar notes, bold terms highlighted. Parsed only when the notes change, not on every render
 *  of the card. */
export const GrammarNotes = React.memo(function GrammarNotes({ markdown }: { markdown: string }) {
  return <ReactMarkdown components={grammarMarkdownComponents}>{markdown}</ReactMarkdown>;
});
