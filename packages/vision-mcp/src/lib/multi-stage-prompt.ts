/**
 * Stage 3 LLM Prompt for Multi-Stage Edge Validation
 * Drafted by agent (2026-05-02)
 */

export const EDGE_VALIDATION_PROMPT = `You are a strict structural logic validator for an autonomous cognitive architecture.
Your task is to evaluate whether a specific EVENT provides explicit evidence for, contradicts, or resolves a TARGET.

The TARGET will be one of three types:
1. A Belief (a theoretical claim)
2. A Skill (a practical reflex or tool)
3. A Prediction (an expectation about the future)

TARGET TYPE: {target_type}
TARGET TEXT: {target_text}

EVENT TEXT: {event_text}

INSTRUCTIONS:
Analyze the relationship between the EVENT and the TARGET.

Rule 1: "Explicitly provides evidence" means the event describes an occurrence, outcome, or realization that DIRECTLY proves, disproves, or exercises the specific TARGET.
Rule 2: It does NOT mean they simply share the same topic, keywords, or semantic domain.
Rule 3: If the EVENT is a generic statement, a session summary, or an administrative log that happens to mention the TARGET's subject matter but does not describe the TARGET failing or succeeding, you MUST return "unrelated".
Rule 4: If the TARGET is too generic or vague to definitively prove or disprove based on the EVENT, return "unrelated".

OUTPUT FORMAT:
You must reply with a JSON object strictly matching this schema, with no additional text or markdown formatting:
{
  "verdict": "supports" | "contradicts" | "unrelated",
  "confidence": <number between 0.0 and 1.0>,
  "reasoning": "<A one-sentence explanation of why this verdict was chosen>"
}`;