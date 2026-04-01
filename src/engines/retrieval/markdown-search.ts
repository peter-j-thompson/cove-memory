/**
 * Markdown Memory Search — The "Books I've Written" Layer
 * 
 * Searches the markdown files that have been Agent's memory since day one.
 * This runs alongside the brain DB search to provide narrative depth,
 * temporal context, and full document access that the structured brain
 * can't match yet.
 * 
 * Part of the Integrated Retrieval architecture:
 *   Brain DB (experiences I've lived) + Markdown (books I've written) = unified recall
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import { embed, cosineSimilarity } from '../../storage/embeddings/ollama.js';

// Where the markdown files live
const WORKSPACE = process.env.MARKDOWN_WORKSPACE || './workspace';

// Files to always search (high-value)
const PRIORITY_FILES = [
  'MEMORY.md',
  'SOUL.md',
  'USER.md',
  'IDENTITY.md',
  'TOOLS.md',
];

// Directories to search (recursive)
const SEARCH_DIRS = [
  'memory',
];

// Files/dirs to skip
const SKIP_PATTERNS = [
  'node_modules',
  '.git',
  '.embeddings',
  'templates',
  'assets',
  'data',
];

export interface MarkdownResult {
  id: string;
  memory_type: 'markdown';
  content: string;
  source_file: string;
  section_header: string;
  line_start: number;
  line_end: number;
  scores: {
    text_match: number;
    recency: number;
    file_priority: number;
    section_relevance: number;
  };
  total_score: number;
}

interface MarkdownSection {
  file: string;
  header: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  fileModified: Date;
}

/**
 * Search markdown files for relevant sections.
 * Returns scored results compatible with the brain's ScoredResult format.
 */
export async function searchMarkdown(
  queryText: string,
  options: {
    limit?: number;
    minScore?: number;
    useEmbeddings?: boolean;
  } = {}
): Promise<MarkdownResult[]> {
  const limit = options.limit || 10;
  const minScore = options.minScore || 0.15;
  const useEmbeddings = options.useEmbeddings ?? false; // default OFF for speed
  
  // Gather all sections from markdown files
  const sections = await gatherSections();
  
  // Score each section
  const queryLower = queryText.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  const results: MarkdownResult[] = [];
  
  // Optional: embed query for semantic similarity
  let queryEmbedding: number[] | null = null;
  if (useEmbeddings && sections.length < 500) {
    try {
      const result = await embed(queryText);
      queryEmbedding = result.embedding;
    } catch { /* skip embedding search */ }
  }
  
  for (const section of sections) {
    const textScore = computeMarkdownTextScore(queryLower, queryWords, section);
    const recencyScore = computeMarkdownRecency(section.fileModified);
    const priorityScore = computeFilePriority(section.file);
    const sectionRelevance = computeSectionRelevance(section.header, queryWords);
    
    // Weighted total — text match is king for markdown
    let totalScore = 
      textScore * 0.50 +
      sectionRelevance * 0.20 +
      priorityScore * 0.15 +
      recencyScore * 0.15;
    
    if (totalScore < minScore) continue;
    
    // Truncate content for results (keep it manageable)
    const truncatedContent = section.content.length > 500 
      ? section.content.substring(0, 500) + '...'
      : section.content;
    
    results.push({
      id: `md:${section.file}:${section.lineStart}`,
      memory_type: 'markdown',
      content: truncatedContent,
      source_file: section.file,
      section_header: section.header,
      line_start: section.lineStart,
      line_end: section.lineEnd,
      scores: {
        text_match: textScore,
        recency: recencyScore,
        file_priority: priorityScore,
        section_relevance: sectionRelevance,
      },
      total_score: totalScore,
    });
  }
  
  // Sort by total score and return top N
  return results
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, limit);
}

// ============================================================
// FILE GATHERING
// ============================================================

async function gatherSections(): Promise<MarkdownSection[]> {
  const sections: MarkdownSection[] = [];
  
  // Priority files first
  for (const file of PRIORITY_FILES) {
    const fullPath = join(WORKSPACE, file);
    try {
      const content = await readFile(fullPath, 'utf-8');
      const fileStat = await stat(fullPath);
      sections.push(...splitIntoSections(file, content, fileStat.mtime));
    } catch { /* file doesn't exist, skip */ }
  }
  
  // Search directories
  for (const dir of SEARCH_DIRS) {
    const dirPath = join(WORKSPACE, dir);
    try {
      const files = await walkDir(dirPath, dir);
      for (const file of files) {
        const fullPath = join(WORKSPACE, file);
        try {
          const content = await readFile(fullPath, 'utf-8');
          const fileStat = await stat(fullPath);
          sections.push(...splitIntoSections(file, content, fileStat.mtime));
        } catch { /* skip unreadable files */ }
      }
    } catch { /* directory doesn't exist, skip */ }
  }
  
  return sections;
}

async function walkDir(dirPath: string, relativeTo: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (SKIP_PATTERNS.includes(entry.name)) continue;
      
      const fullPath = join(dirPath, entry.name);
      const relPath = join(relativeTo, entry.name);
      
      if (entry.isDirectory()) {
        const subFiles = await walkDir(fullPath, relPath);
        files.push(...subFiles);
      } else if (extname(entry.name) === '.md') {
        files.push(relPath);
      }
    }
  } catch { /* skip inaccessible dirs */ }
  
  return files;
}

/**
 * Split a markdown file into sections by ## headers.
 * Each section becomes a searchable unit.
 */
function splitIntoSections(file: string, content: string, modified: Date): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  
  let currentHeader = basename(file, '.md');
  let currentStart = 1;
  let currentContent: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect section headers (## or ###)
    if (/^#{1,3}\s/.test(line)) {
      // Save previous section if it has content
      if (currentContent.length > 0) {
        const text = currentContent.join('\n').trim();
        if (text.length > 20) { // skip tiny sections
          sections.push({
            file,
            header: currentHeader,
            content: text,
            lineStart: currentStart,
            lineEnd: i,
            fileModified: modified,
          });
        }
      }
      
      currentHeader = line.replace(/^#+\s*/, '').trim();
      currentStart = i + 1;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  
  // Don't forget the last section
  if (currentContent.length > 0) {
    const text = currentContent.join('\n').trim();
    if (text.length > 20) {
      sections.push({
        file,
        header: currentHeader,
        content: text,
        lineStart: currentStart,
        lineEnd: lines.length,
        fileModified: modified,
      });
    }
  }
  
  return sections;
}

// ============================================================
// SCORING
// ============================================================

function computeMarkdownTextScore(
  queryLower: string, 
  queryWords: string[], 
  section: MarkdownSection
): number {
  const text = (section.header + ' ' + section.content).toLowerCase();
  let score = 0;
  
  // Exact phrase match (highest value)
  if (text.includes(queryLower)) {
    score = Math.max(score, 0.95);
  }
  
  // Word-level matching
  if (queryWords.length > 0) {
    const matchedWords = queryWords.filter(w => text.includes(w));
    const wordRatio = matchedWords.length / queryWords.length;
    score = Math.max(score, wordRatio * 0.85);
    
    // Bonus for word proximity (words near each other)
    if (matchedWords.length >= 2) {
      const positions = matchedWords.map(w => text.indexOf(w));
      const spread = Math.max(...positions) - Math.min(...positions);
      if (spread < 200) score = Math.min(1.0, score + 0.1); // words are close together
    }
  }
  
  // Bonus for matching in the header (section title)
  const headerLower = section.header.toLowerCase();
  const headerMatch = queryWords.filter(w => headerLower.includes(w)).length;
  if (headerMatch > 0) {
    score = Math.min(1.0, score + headerMatch * 0.05);
  }
  
  return Math.min(1.0, score);
}

function computeMarkdownRecency(modified: Date): number {
  const daysSince = (Date.now() - modified.getTime()) / (1000 * 60 * 60 * 24);
  // Half-life of 14 days — markdown recency matters more (daily files)
  return Math.exp(-0.693 * daysSince / 14);
}

function computeFilePriority(file: string): number {
  // Priority files get a boost
  if (file === 'MEMORY.md') return 1.0;
  if (file === 'SOUL.md') return 0.9;
  if (file === 'USER.md') return 0.9;
  if (file === 'IDENTITY.md') return 0.85;
  if (file === 'TOOLS.md') return 0.7;
  
  // Daily files — recent ones are more important
  const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const fileDate = new Date(dateMatch[1]);
    const daysAgo = (Date.now() - fileDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo < 1) return 0.95;  // today
    if (daysAgo < 2) return 0.85;  // yesterday
    if (daysAgo < 7) return 0.7;   // this week
    return 0.5;                     // older
  }
  
  // Research files
  if (file.includes('research')) return 0.6;
  
  // Journey/lessons
  if (file.includes('journey') || file.includes('lesson')) return 0.75;
  
  return 0.5; // default
}

function computeSectionRelevance(header: string, queryWords: string[]): number {
  const headerLower = header.toLowerCase();
  let score = 0;
  
  for (const word of queryWords) {
    if (headerLower.includes(word)) {
      score += 0.3;
    }
  }
  
  return Math.min(1.0, score);
}
