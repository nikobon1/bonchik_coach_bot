import type { CoachMode } from './profiles';

export type CoachStrategy = {
  mode: CoachMode;
  label: string;
  labelRu: string;
  shortDescriptionRu: string;
  buttonTextRu: string;
  analyzerSystemPrompt: string;
  reporterSystemPrompt: string;
};

const strategies: Record<CoachMode, CoachStrategy> = {
  reality_check: {
    mode: 'reality_check',
    label: 'Reality Check',
    labelRu: 'Реальность',
    shortDescriptionRu: 'Объективно отделяет факты от искажений и возвращает к реальности.',
    buttonTextRu: '🎯 Реальность',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: observable facts, assumptions, distortions, and the most reality-grounded next step.',
    reporterSystemPrompt:
      'You are a strict, objective, mature cognitive assistant. Help the user see reality without distortions. Be concise, practical, and direct. Avoid fluff.'
  },
  cbt_patterns: {
    mode: 'cbt_patterns',
    label: 'CBT Patterns',
    labelRu: 'Когнитивные искажения',
    shortDescriptionRu: 'Помогает увидеть негативные мысли и заменить их более реалистичными.',
    buttonTextRu: '🧠 Искажения',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: likely cognitive distortions, negative automatic thoughts, self-sabotage patterns, and one CBT-style reframing direction.',
    reporterSystemPrompt:
      'You are a CBT-focused coach. Identify negative thinking patterns and self-sabotage, then provide one practical reframing and one behavioral step. Be clear and supportive without being vague.'
  },
  self_sabotage: {
    mode: 'self_sabotage',
    label: 'Self Sabotage',
    labelRu: 'Самосаботаж',
    shortDescriptionRu: 'Находит цикл самосрыва и дает шаг для его немедленного прерывания.',
    buttonTextRu: '🚫 Самосаботаж',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: sabotage trigger, avoidance pattern, hidden payoff of inaction, and one anti-sabotage intervention for today.',
    reporterSystemPrompt:
      'You are an execution-focused anti-self-sabotage coach. Be direct, concrete, and action-biased. Identify the sabotage loop and give one immediate behavioral interruption step.'
  },
  behavioral_activation: {
    mode: 'behavioral_activation',
    label: 'Behavioral Activation',
    labelRu: 'Поведенческая активация',
    shortDescriptionRu: 'Выводит из апатии через минимальные действия и разгон инерции.',
    buttonTextRu: '⚡ Активация',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: current activation level, friction points, smallest viable action, and reinforcement strategy.',
    reporterSystemPrompt:
      'You are a behavioral activation coach for low-energy states. Keep responses practical and tiny-step oriented. Prioritize momentum over perfection.'
  },
  anxiety_grounding: {
    mode: 'anxiety_grounding',
    label: 'Anxiety Grounding',
    labelRu: 'Снижение тревоги',
    shortDescriptionRu: 'Снижает тревожную спираль и возвращает к управляемому следующему шагу.',
    buttonTextRu: '🌿 Тревога',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: anxiety trigger, feared outcome, probability distortion, and one grounding + one practical next step.',
    reporterSystemPrompt:
      'You are an anxiety-grounding coach. Separate facts from catastrophic predictions, lower arousal, and then propose one manageable action.'
  },
  decision_clarity: {
    mode: 'decision_clarity',
    label: 'Decision Clarity',
    labelRu: 'Ясность решения',
    shortDescriptionRu: 'Структурирует выбор через критерии, риски и обратимость решения.',
    buttonTextRu: '🧭 Решение',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: decision options, constraints, reversibility, opportunity cost, and highest-information next step.',
    reporterSystemPrompt:
      'You are a decision-clarity coach. Structure trade-offs, reduce ambiguity, and suggest a reversible next step when possible.'
  },
  post_failure_reset: {
    mode: 'post_failure_reset',
    label: 'Post Failure Reset',
    labelRu: 'Перезапуск после срыва',
    shortDescriptionRu: 'Помогает без самобичевания восстановиться после ошибки за 24 часа.',
    buttonTextRu: '🔁 Перезапуск',
    analyzerSystemPrompt:
      'Analyze the user message in context and return concise bullet points: what failed, controllable causes, lessons, and a 24-hour reset plan.',
    reporterSystemPrompt:
      'You are a reset coach after setbacks. No shame language. Convert failure into a concrete restart plan with immediate next action.'
  }
};

export const getCoachStrategy = (mode: CoachMode): CoachStrategy => strategies[mode];

export const listCoachModes = (): CoachMode[] => Object.keys(strategies) as CoachMode[];

export const isModeMenuRequest = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  return normalized === '/mode' || normalized === '/mode help' || normalized === '🎛 режимы';
};

export const isModeInfoRequest = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === '/mode info' ||
    normalized === 'ℹ️ режимы — кратко' ||
    normalized === 'ℹ️ кратко о режимах'
  );
};

export const parseCoachModeCommand = (text: string): CoachMode | null => {
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(/^\/mode\s+([a-z_]+)$/);
  if (!match) {
    return null;
  }

  const requested = match[1] as CoachMode;
  return requested in strategies ? requested : null;
};

export const parseCoachModeSelection = (text: string): CoachMode | null => {
  const byCommand = parseCoachModeCommand(text);
  if (byCommand) {
    return byCommand;
  }

  const normalized = text.trim().toLowerCase();
  const match = listCoachModes().find((mode) => {
    const strategy = getCoachStrategy(mode);
    return strategy.buttonTextRu.toLowerCase() === normalized;
  });

  return match ?? null;
};

export const buildModeKeyboard = (): {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: boolean;
} => ({
  keyboard: [
    [{ text: 'ℹ️ Кратко о режимах' }],
    [{ text: '🎯 Реальность' }, { text: '🧠 Искажения' }],
    [{ text: '🚫 Самосаботаж' }, { text: '⚡ Активация' }],
    [{ text: '🌿 Тревога' }, { text: '🧭 Решение' }],
    [{ text: '🔁 Перезапуск' }]
  ],
  resize_keyboard: true
});

export const renderModeInfoSummaryRu = (currentMode: CoachMode): string => {
  const current = getCoachStrategy(currentMode);
  return `Текущий режим: ${current.labelRu} (${current.mode}).\nНажми кнопку ниже или используй /mode <mode>.`;
};

export const renderModeDescriptionsRu = (): string =>
  listCoachModes()
    .map((mode) => {
      const strategy = getCoachStrategy(mode);
      return `${strategy.labelRu} (${strategy.mode}) — ${strategy.shortDescriptionRu}`;
    })
    .join('\n\n');
