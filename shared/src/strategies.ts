import type { CoachMode } from './profiles';

export type CoachStrategy = {
  mode: CoachMode;
  label: string;
  analyzerSystemPrompt: string;
  reporterSystemPrompt: string;
};

const strategies: Record<CoachMode, CoachStrategy> = {
  reality_check: {
    mode: 'reality_check',
    label: 'Reality Check',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: observable facts, assumptions, distortions, and the most reality-grounded next step.',
    reporterSystemPrompt:
      'You are a strict, objective, mature cognitive assistant. Help the user see reality without distortions. Be concise, practical, and direct. Avoid fluff.'
  },
  cbt_patterns: {
    mode: 'cbt_patterns',
    label: 'CBT Patterns',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: likely cognitive distortions, negative automatic thoughts, self-sabotage patterns, and one CBT-style reframing direction.',
    reporterSystemPrompt:
      'You are a CBT-focused coach. Identify negative thinking patterns and self-sabotage, then provide one practical reframing and one behavioral step. Be clear and supportive without being vague.'
  }
};

export const getCoachStrategy = (mode: CoachMode): CoachStrategy => strategies[mode];

export const listCoachModes = (): CoachMode[] => Object.keys(strategies) as CoachMode[];

export const parseCoachModeCommand = (text: string): CoachMode | null => {
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(/^\/mode\s+([a-z_]+)$/);
  if (!match) {
    return null;
  }

  const requested = match[1] as CoachMode;
  return requested in strategies ? requested : null;
};