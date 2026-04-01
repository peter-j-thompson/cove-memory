/**
 * Markdown Memory Reader — READ-ONLY bridge to existing memory files.
 * 
 * 🚨 SHADOW SYSTEM RULE: This module NEVER writes to markdown files.
 * It reads the current memory system and feeds data into OpenMemory.
 * The markdown system remains the primary, untouched source of truth.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

const MEMORY_DIR = process.env.MARKDOWN_MEMORY_DIR || (process.env.HOME + '/memory');

export interface MarkdownFile {
  path: string;
  filename: string;
  content: string;
  type: 'soul' | 'identity' | 'user' | 'memory' | 'daily' | 'lesson' | 'research' | 'tool' | 'heartbeat' | 'other';
  lastModified: Date;
  sizeBytes: number;
}

export interface MemorySection {
  file: string;
  heading: string;
  level: number;  // 1 = #, 2 = ##, 3 = ###
  content: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Classify a file by its role in the memory system.
 */
function classifyFile(filename: string, relativePath: string): MarkdownFile['type'] {
  const lower = filename.toLowerCase();
  if (lower === 'soul.md') return 'soul';
  if (lower === 'identity.md') return 'identity';
  if (lower === 'user.md') return 'user';
  if (lower === 'memory.md') return 'memory';
  if (lower === 'lessons.md') return 'lesson';
  if (lower === 'heartbeat.md') return 'heartbeat';
  if (lower === 'tools.md') return 'tool';
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(lower)) return 'daily';
  if (relativePath.includes('research')) return 'research';
  return 'other';
}

/**
 * Read all markdown files from the memory directory.
 */
export function readAllFiles(): MarkdownFile[] {
  const files: MarkdownFile[] = [];
  
  function scanDir(dir: string, relativePath: string = '') {
    if (!existsSync(dir)) return;
    
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      // Skip hidden dirs, node_modules, templates, tools, data, etc.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || 
            ['node_modules', 'templates', 'tools', 'data', 'skills', 'cove-ai', 'documents'].includes(entry.name)) {
          continue;
        }
        scanDir(fullPath, join(relativePath, entry.name));
        continue;
      }
      
      if (extname(entry.name) !== '.md') continue;
      
      const stat = statSync(fullPath);
      const content = readFileSync(fullPath, 'utf-8');
      const relPath = join(relativePath, entry.name);
      
      files.push({
        path: fullPath,
        filename: entry.name,
        content,
        type: classifyFile(entry.name, relPath),
        lastModified: stat.mtime,
        sizeBytes: stat.size,
      });
    }
  }
  
  scanDir(MEMORY_DIR);
  return files;
}

/**
 * Parse a markdown file into headed sections.
 * This is how we chunk content for embedding and semantic analysis.
 */
export function parseIntoSections(file: MarkdownFile): MemorySection[] {
  const lines = file.content.split('\n');
  const sections: MemorySection[] = [];
  
  let currentHeading = file.filename.replace('.md', '');
  let currentLevel = 1;
  let currentContent: string[] = [];
  let currentLineStart = 1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    
    if (headingMatch) {
      // Save previous section if it has content
      const content = currentContent.join('\n').trim();
      if (content.length > 20) {  // Skip tiny/empty sections
        sections.push({
          file: file.path,
          heading: currentHeading,
          level: currentLevel,
          content,
          lineStart: currentLineStart,
          lineEnd: i,
        });
      }
      
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentContent = [];
      currentLineStart = i + 1;
    } else {
      currentContent.push(line);
    }
  }
  
  // Don't forget the last section
  const content = currentContent.join('\n').trim();
  if (content.length > 20) {
    sections.push({
      file: file.path,
      heading: currentHeading,
      level: currentLevel,
      content,
      lineStart: currentLineStart,
      lineEnd: lines.length,
    });
  }
  
  return sections;
}

/**
 * Read a specific file by name.
 */
export function readFile(filename: string): MarkdownFile | null {
  const allFiles = readAllFiles();
  return allFiles.find(f => f.filename === filename) || null;
}

/**
 * Get file count and total size — useful for health checks.
 */
export function getStats(): {
  totalFiles: number;
  totalSizeKb: number;
  byType: Record<string, number>;
} {
  const files = readAllFiles();
  const byType: Record<string, number> = {};
  
  for (const f of files) {
    byType[f.type] = (byType[f.type] || 0) + 1;
  }
  
  return {
    totalFiles: files.length,
    totalSizeKb: Math.round(files.reduce((sum, f) => sum + f.sizeBytes, 0) / 1024),
    byType,
  };
}
