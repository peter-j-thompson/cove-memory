/**
 * Session Transcript Processor
 * 
 * Batch processes session transcripts (.jsonl files)
 * through the Sensory Buffer pipeline to populate the brain
 * from past conversations.
 * 
 * This proves the Sensory pipeline works and seeds the brain
 * with rich conversational data that markdown ingestion can't capture.
 */

import { readFileSync, existsSync } from 'fs';
import { SensoryProcessor, type ProcessedMessage } from './processor.js';
import { query } from '../../storage/db.js';

interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  name?: string;
}

interface TranscriptProcessResult {
  transcriptPath: string;
  messagesRead: number;
  messagesProcessed: number;
  entitiesFound: number;
  factualClaimsFound: number;
  episodesCreated: number;
  semanticUpserts: number;
  intentBreakdown: Record<string, number>;
  sentimentSummary: {
    avgValence: number;
    avgArousal: number;
    dominantEmotions: string[];
  };
  processingTime_ms: number;
  errors: string[];
}

/**
 * Process an Agent platform session transcript file.
 */
export async function processTranscript(
  transcriptPath: string,
  options: { 
    dryRun?: boolean;      // Don't write to DB, just analyze
    maxMessages?: number;   // Limit messages to process
    sessionId?: string;     // Override session ID
  } = {}
): Promise<TranscriptProcessResult> {
  const start = Date.now();
  const result: TranscriptProcessResult = {
    transcriptPath,
    messagesRead: 0,
    messagesProcessed: 0,
    entitiesFound: 0,
    factualClaimsFound: 0,
    episodesCreated: 0,
    semanticUpserts: 0,
    intentBreakdown: {},
    sentimentSummary: { avgValence: 0, avgArousal: 0, dominantEmotions: [] },
    processingTime_ms: 0,
    errors: [],
  };

  if (!existsSync(transcriptPath)) {
    result.errors.push(`File not found: ${transcriptPath}`);
    return result;
  }

  // Read JSONL transcript
  const lines = readFileSync(transcriptPath, 'utf-8')
    .split('\n')
    .filter(l => l.trim());

  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      
      // Agent platform v3 transcript format: {"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
      if (parsed.type === 'message' && parsed.message?.role && parsed.message?.content) {
        const msg = parsed.message;
        let textContent = '';
        
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          textContent = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        }
        
        if (textContent) {
          messages.push({
            role: msg.role,
            content: textContent,
            timestamp: parsed.timestamp || msg.timestamp,
            name: msg.name,
          });
        }
      }
      // Also support simple format: {"role":"user","content":"..."}
      else if (parsed.role && parsed.content) {
        messages.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  result.messagesRead = messages.length;
  console.log(`[TRANSCRIPT] Read ${messages.length} messages from ${transcriptPath}`);

  // Initialize processor
  const processor = new SensoryProcessor();
  await processor.loadFromDB();

  // Process each message
  const processed: ProcessedMessage[] = [];
  const limit = options.maxMessages || messages.length;
  let totalValence = 0;
  let totalArousal = 0;
  const emotionCounts: Record<string, number> = {};

  for (let i = 0; i < Math.min(limit, messages.length); i++) {
    const msg = messages[i];
    
    // Skip system messages and tool outputs for now
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') continue;
    
    // Skip very short messages
    if (!msg.content || msg.content.length < 10) continue;
    
    // Skip messages that are just tool calls or JSON
    if (msg.content.startsWith('{') || msg.content.startsWith('[')) continue;

    const sender = msg.role === 'user' ? (msg.name || 'User') : 'Agent';
    
    try {
      const p = processor.process(msg.content, sender, options.sessionId);
      processed.push(p);
      result.messagesProcessed++;
      
      // Aggregate stats
      result.entitiesFound += p.entities.length;
      result.factualClaimsFound += p.factualClaims.length;
      result.intentBreakdown[p.intent] = (result.intentBreakdown[p.intent] || 0) + 1;
      
      totalValence += p.sentiment.valence;
      totalArousal += p.sentiment.arousal;
      for (const e of p.sentiment.emotions) {
        emotionCounts[e] = (emotionCounts[e] || 0) + 1;
      }
    } catch (err) {
      result.errors.push(`Message ${i}: ${(err as Error).message}`);
    }
  }

  // Compute sentiment summary
  if (result.messagesProcessed > 0) {
    result.sentimentSummary.avgValence = totalValence / result.messagesProcessed;
    result.sentimentSummary.avgArousal = totalArousal / result.messagesProcessed;
    result.sentimentSummary.dominantEmotions = Object.entries(emotionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([e]) => e);
  }

  // Write to DB if not dry run
  if (!options.dryRun) {
    // Create episodes from conversation segments
    const episodeSize = 10; // Group every 10 messages into an episode
    for (let i = 0; i < processed.length; i += episodeSize) {
      const segment = processed.slice(i, i + episodeSize);
      const segmentText = segment.map(p => `[${p.sender}] ${p.rawText.substring(0, 500)}`).join('\n');
      const segmentEntities = [...new Set(segment.flatMap(p => p.entities.map(e => e.name)))];
      const segmentIntents = [...new Set(segment.map(p => p.intent))];
      
      // Average sentiment for this segment
      const segValence = segment.reduce((sum, p) => sum + p.sentiment.valence, 0) / segment.length;
      const segArousal = segment.reduce((sum, p) => sum + p.sentiment.arousal, 0) / segment.length;
      
      try {
        await query(
          `INSERT INTO episodes (
            session_id, summary, detailed_narrative, topics, 
            importance_score, emotional_arc, outcome
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            options.sessionId || `transcript-${Date.now()}`,
            `Conversation segment: ${segmentIntents.join(', ')} | Entities: ${segmentEntities.slice(0, 5).join(', ')}`,
            segmentText.substring(0, 4000),
            segmentEntities.slice(0, 20),
            Math.min(1.0, 0.3 + segmentEntities.length * 0.05),
            JSON.stringify({
              start: { valence: segValence, arousal: segArousal },
              trajectory: segValence > 0.3 ? 'positive' : segValence < -0.3 ? 'negative' : 'stable',
              end_state: { valence: segValence, arousal: segArousal },
            }),
            JSON.stringify({
              type: 'informational',
              description: 'Processed from session transcript',
              verified: true,
            }),
          ]
        );
        result.episodesCreated++;
      } catch (err) {
        result.errors.push(`Episode creation: ${(err as Error).message}`);
      }
    }

    // Upsert entities that were found in the conversation
    const entityCounts = new Map<string, { entity: ProcessedMessage['entities'][0]; count: number }>();
    for (const p of processed) {
      for (const e of p.entities) {
        const key = e.name.toLowerCase();
        const existing = entityCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          entityCounts.set(key, { entity: e, count: 1 });
        }
      }
    }

    // Verify entities that were mentioned (refresh their last_verified)
    for (const [, data] of entityCounts) {
      if (data.entity.isKnown && data.entity.matchedNodeId) {
        try {
          await query(
            'UPDATE semantic_nodes SET last_verified = NOW() WHERE id = $1',
            [data.entity.matchedNodeId]
          );
          result.semanticUpserts++;
        } catch (err) {
          result.errors.push(`Verify ${data.entity.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  result.processingTime_ms = Date.now() - start;
  return result;
}
