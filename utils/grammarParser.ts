/**
 * Parse markdown grammar content into structured sections
 * Handles patterns like:
 * - **Section Title:** content
 * - **Section Title**\n content
 * - Section Title:\n content
 */

export interface GrammarSection {
  title: string;
  content: string;
  icon?: string;
}

// Map common section titles to icons
const sectionIcons: Record<string, string> = {
  'complex sentence analysis': '📝',
  'sentence analysis': '📝',
  'grammar': '📚',
  'grammar points': '📚',
  'present perfect': '⏰',
  'passive voice': '🔄',
  'listing structure': '📋',
  'nuance': '💡',
  'nuance/tone': '💡',
  'tone': '🎭',
  'register': '📊',
  'formal': '👔',
  'structure': '🏗️',
  'key points': '🔑',
  'vocabulary': '📖',
  'usage': '✍️',
  'context': '🌍',
  'meaning': '💬',
};

function getIconForSection(title: string): string | undefined {
  const lowerTitle = title.toLowerCase();
  for (const [key, icon] of Object.entries(sectionIcons)) {
    if (lowerTitle.includes(key)) {
      return icon;
    }
  }
  return undefined;
}

export function parseGrammarSections(markdown: string): GrammarSection[] {
  if (!markdown || typeof markdown !== 'string') {
    return [];
  }

  const sections: GrammarSection[] = [];
  
  // Split by bold section headers: **Title:** or **Title**
  // Match patterns like "**Complex Sentence Analysis:**" or just "**Title**"
  const sectionRegex = /\*\*([^*]+)\*\*:?\s*/g;
  
  const parts = markdown.split(sectionRegex);
  
  // parts will be: [before first header, header1, content1, header2, content2, ...]
  // Skip the first element if it's empty or just whitespace
  let startIdx = 0;
  if (parts[0] && parts[0].trim()) {
    // There's content before the first header - treat it as intro
    sections.push({
      title: 'Overview',
      content: parts[0].trim(),
      icon: '📋'
    });
    startIdx = 1;
  } else {
    startIdx = 1;
  }

  // Process pairs of (title, content)
  for (let i = startIdx; i < parts.length; i += 2) {
    const title = parts[i]?.trim();
    const content = parts[i + 1]?.trim();
    
    if (title && content) {
      sections.push({
        title,
        content,
        icon: getIconForSection(title)
      });
    } else if (title && !content) {
      // Title with no content - might be a standalone point
      sections.push({
        title,
        content: '',
        icon: getIconForSection(title)
      });
    }
  }

  // If no sections found, return the whole content as one section
  if (sections.length === 0 && markdown.trim()) {
    sections.push({
      title: 'Analysis',
      content: markdown.trim(),
      icon: '📝'
    });
  }

  return sections;
}

/**
 * Format section content for display
 * - Handles bullet points
 * - Cleans up extra whitespace
 */
export function formatSectionContent(content: string): string {
  if (!content) return '';
  
  return content
    // Normalize line breaks
    .replace(/\r\n/g, '\n')
    // Clean up multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


