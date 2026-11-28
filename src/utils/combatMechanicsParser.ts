import type {
  ChaseStateCode,
  NinjaBaseStats,
  NinjaChaseComboLink,
  NinjaCombatProfile,
  NinjaMediaProfile,
  NinjaPassiveInfo,
  NinjaSkillInfo,
  SkillTargetType,
} from '../types/sprite';

export const CHASE_STATE_LABELS: Record<ChaseStateCode, string> = {
  fall: 'Queda / Derrubado',
  popup: 'Flutuação Baixa',
  launcher: 'Flutuação Alta',
  back: 'Empurrão / Repelido',
};

export const CHASE_SYSTEM_LEGEND = {
  fall: 'Queda / Derrubado (alvo cai no chão)',
  popup: 'Flutuação Baixa (alvo é lançado em baixa altitude)',
  launcher: 'Flutuação Alta (alvo é lançado em grande altitude)',
  back: 'Empurrão / Repelido (alvo é arremessado para trás)',
} as const;

const NATURE_MAP: Record<number, { code: string; label: string }> = {
  1: { code: 'wind', label: 'Vento' },
  2: { code: 'fire', label: 'Fogo' },
  3: { code: 'earth', label: 'Terra' },
  4: { code: 'water', label: 'Água' },
  5: { code: 'thunder', label: 'Relâmpago' },
};

const COMBAT_ROLE_LABELS: Record<string, string> = {
  tank: 'Tanque',
  gank: 'Controle / Estratégia',
  dps: 'Dano (DPS)',
};

const ELEMENT_FLAG_LABELS: Record<string, string> = {
  fire: 'Fogo',
  water: 'Água',
  wind: 'Vento',
  thunder: 'Relâmpago',
  earth: 'Terra',
};

const TARGET_MAP: Record<string, { type: SkillTargetType; label: string }> = {
  ENEMY: { type: 'single_enemy', label: 'Único Inimigo' },
  ENEMY_ROW: { type: 'enemy_row', label: 'Fileira de Inimigos' },
  ENEMY_COL: { type: 'enemy_col', label: 'Coluna de Inimigos' },
  ENEMY_ALL: { type: 'all_enemies', label: 'Todos os Inimigos' },
  ENEMY3: { type: 'multi_enemy_3', label: 'Até 3 Inimigos' },
  ENEMY_RANDOM_2: { type: 'random_enemies', label: '2 Inimigos Aleatórios' },
  ENEMY_RANDOM_3: { type: 'random_enemies', label: '3 Inimigos Aleatórios' },
  ENEMY_RANDOM_4: { type: 'random_enemies', label: '4 Inimigos Aleatórios' },
  ENEMY_RANDOM_5: { type: 'random_enemies', label: '5 Inimigos Aleatórios' },
  FRIEND_ALL: { type: 'all_allies', label: 'Todos os Aliados' },
};

const DAMAGE_CATEGORY_TERMS = new Set([
  'taijutsu',
  'ninjutsu',
  'taijutsu/ninjutsu',
  'ninjutsu/taijutsu',
  'genjutsu',
]);

const ELEMENT_BRACKET_TERMS = new Set([
  'fogo',
  'água',
  'agua',
  'vento',
  'trovão',
  'trovao',
  'relâmpago',
  'relampago',
  'raio',
  'terra',
  'madeira',
]);

export function stripHtmlTags(raw?: string | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeChaseFlag(flag: unknown): ChaseStateCode | null {
  if (typeof flag !== 'string') return null;
  const f = flag.trim().toLowerCase();
  if (f === 'fall' || f === 'popup' || f === 'launcher' || f === 'back') {
    return f;
  }
  return null;
}


function detectChaseStateFromTerm(termRaw: string): ChaseStateCode | null {
  const t = termRaw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/\bnao\b|\bimune\b/.test(t)) return null;

  if (
    t === 'derrubar' ||
    t === 'derrubado' ||
    t === 'derrubados' ||
    t === 'queda' ||
    t === 'caido' ||
    t === 'derrota' ||
    t === 'fall' ||
    t === 'knockdown' ||
    t.includes('derrub')
  ) {
    return 'fall';
  }
  if (
    t === 'flutuacao baixa' ||
    t === 'flutuacao pequena' ||
    t === 'flutuacao menor' ||
    t === 'flutuacao' ||
    t === 'popup' ||
    t.includes('flutuacao baixa') ||
    t.includes('flutuacao pequena') ||
    t.includes('flutuacao menor')
  ) {
    return 'popup';
  }
  if (
    t === 'flutuacao alta' ||
    t === 'grande flutuacao' ||
    t === 'da fu kong' ||
    t === 'launcher' ||
    t.includes('flutuacao alta') ||
    t.includes('grande flutuacao')
  ) {
    return 'launcher';
  }
  if (
    t === 'empurrao' ||
    t === 'empurrado' ||
    t === 'empurrar' ||
    t === 'repelir' ||
    t === 'repelido' ||
    t === 'repelimento' ||
    t === 'repulsao' ||
    t === 'recuar' ||
    t === 'recuo' ||
    t === 'back' ||
    t === 'knockback' ||
    t.includes('empurr') ||
    t.includes('repel') ||
    t.includes('recu')
  ) {
    return 'back';
  }
  return null;
}

function stripChaseTriggerAndNegationClauses(plain: string): string {
  // Remove parenthetical explanatory tooltips like "(não pode repelir, dura 2 rodadas)"
  let cleaned = plain.replace(/\([^)]{0,120}\)/g, ' ');
  // Remove leading chase trigger clauses like "Persegue inimigos repelidos," / "Persegue alvos (Repelimento):" / "persegue após [Flutuação Pequena],"
  cleaned = cleaned.replace(
    /\b(?:persegue|segue)\s+(?:ap[oó]s\s+(?:\[[^\]]+\]|[^,;:.]{2,40})|(?:os?\s+)?(?:inimigos?|alvos?|unidades?)\s+(?:em\s+|com\s+|sob\s+)?(?:derrubad[oa]s?|ca[ií]d[oa]s?|repelid[oa]s?|empurrad[oa]s?|arremessad[oa]s?\s+(?:ao|para\s+o)\s+alto|em\s+flutua[çc][ãa]o[^,;:.]*|\[[^\]]+\]))[,;:\s-]*/gi,
    ' '
  );
  // Remove "causa/inflige X no [estado]" or negated phrases like "não pode repelir" / "não pode ser repelido"
  cleaned = cleaned.replace(/\bn[ãa]o\s+(?:pode|podem|causa)\s+[^.;,]{1,40}/gi, ' ');
  return cleaned;
}

/**
 * Extracts which combo/chase states (fall, popup, launcher, back) a skill INFLICTS on targets,
 * supporting both bracketed terms ("[Flutuação Pequena]", "[Recuar]", "[Derrota]") and natural
 * unbracketed PT-BR phrasing ("e arremessa ao alto", "e repele", "Derruba o alvo"), while
 * excluding chase-trigger prefixes and negations.
 */
export function extractCausedChaseStates(
  descPlain: string,
  knownTriggers: ChaseStateCode[] = []
): ChaseStateCode[] {
  if (!descPlain) return [];
  const caused = new Set<ChaseStateCode>();

  // 1) Explicit result clauses with brackets: "para causar [X]", "e causa [X]", "causando [X]", "infligir [X]"
  const resultClauseRegex =
    /(?:para\s+causar|causa(?:ndo)?|inflig(?:e|ir|indo)|gera(?:ndo)?|provoca(?:ndo)?|arremessa(?:ndo)?|lan[çc]a(?:ndo)?)\s*(?:o\s+|um\s+|uma\s+|efeito\s+de\s+|estado\s+de\s+)?\[([^\]]{2,36})\]/gi;
  let match: RegExpExecArray | null;
  while ((match = resultClauseRegex.exec(descPlain)) !== null) {
    const st = detectChaseStateFromTerm(match[1]);
    if (st) caused.add(st);
  }

  // 2) For non-chase skills, any bracketed chase state in description is inflicted by the skill
  if (knownTriggers.length === 0) {
    const bracketRegex = /\[([^\]]{2,36})\]/g;
    while ((match = bracketRegex.exec(descPlain)) !== null) {
      const st = detectChaseStateFromTerm(match[1]);
      if (st) caused.add(st);
    }
  } else if (caused.size === 0) {
    // Fallback for chase skills whose phrasing omits "causar" before the second bracket
    const foundInOrder: ChaseStateCode[] = [];
    const bracketRegex = /\[([^\]]{2,36})\]/g;
    while ((match = bracketRegex.exec(descPlain)) !== null) {
      const st = detectChaseStateFromTerm(match[1]);
      if (st) foundInOrder.push(st);
    }
    if (foundInOrder.length >= 2) {
      for (const st of foundInOrder.slice(1)) {
        caused.add(st);
      }
    } else if (foundInOrder.length === 1 && !knownTriggers.includes(foundInOrder[0])) {
      caused.add(foundInOrder[0]);
    }
  }

  // 3) Natural unbracketed PT-BR combat phrases on stripped non-trigger text
  const stripped = stripChaseTriggerAndNegationClauses(descPlain)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/\b(?:flutuacao\s+alta|grande\s+flutuacao)\b/.test(stripped)) {
    caused.add('launcher');
  }
  if (
    /\bflutuacao\s+(?:baixa|pequena|menor)\b/.test(stripped) ||
    /\b(?:arremessa|arremessar|arremessando|lanca|lancar|lancando|joga|jogar|jogando)\s+(?:os?\s+(?:alvos?|inimigos?)\s+)?(?:para\s+o\s+|ao\s+)?alto\b/.test(
      stripped
    )
  ) {
    // Only add popup if launcher wasn't explicitly specified right alongside
    if (!/\b(?:flutuacao\s+alta|grande\s+flutuacao)\b/.test(stripped)) {
      caused.add('popup');
    }
  }
  if (
    /\b(?:repele|repelir|repelindo|empurra|empurrar|empurrando)\b/.test(stripped) ||
    /\b(?:causa(?:ndo)?|inflig\w+|provoca(?:ndo)?)\s+(?:[a-z]+\s+){0,2}(?:empurrao|repulsao|repelimento|recuo)\b/.test(
      stripped
    ) ||
    /\bfaz\s+recuar\b/.test(stripped)
  ) {
    // Guard against "repele [empurrado] para causar [Derrubar]" where "repele" is describing the chase trigger
    const isTriggerRepele =
      knownTriggers.length > 0 &&
      /\brepele\s*\[/.test(descPlain.toLowerCase()) &&
      caused.size > 0;
    if (!isTriggerRepele) {
      caused.add('back');
    }
  }
  if (
    /\b(?:derruba|derrubar|derrubando)\b/.test(stripped) ||
    /\b(?:causa(?:ndo)?|inflig\w+|provoca(?:ndo)?)\s+(?:a\s+)?queda\b/.test(stripped) ||
    /\bdeixa(?:ndo)?\s+(?:o\s+alvo\s+|os\s+alvos\s+)?caido\b/.test(stripped)
  ) {
    caused.add('fall');
  }

  return Array.from(caused);
}

/**
 * Extracts structured combat metadata from a raw skill entry in dados/jogo/skills.json.
 */
export function parseRawSkillMechanics(
  rawSkill: Record<string, unknown>,
  descResolved?: string,
  resolveText?: (val: unknown) => string | undefined
): Omit<NinjaSkillInfo, 'id' | 'animKey' | 'slotLabel' | 'name' | 'iconName' | 'iconUrl'> {
  const descPlain = stripHtmlTags(descResolved);
  const descShort = stripHtmlTags(
    resolveText ? resolveText(rawSkill.desc_short) : String(rawSkill.desc_short || '')
  );
  const descInBattle = stripHtmlTags(
    resolveText ? resolveText(rawSkill.descInBattle) : String(rawSkill.descInBattle || '')
  );

  const rawFlags = Array.isArray(rawSkill.flags)
    ? rawSkill.flags.map((f) => String(f || '').trim()).filter(Boolean)
    : [];

  let targetType: SkillTargetType | undefined;
  let targetLabel: string | undefined;
  const elementsSet = new Set<string>();

  for (const f of rawFlags) {
    if (!targetType && TARGET_MAP[f]) {
      targetType = TARGET_MAP[f].type;
      targetLabel = TARGET_MAP[f].label;
    }
    const low = f.toLowerCase();
    if (ELEMENT_FLAG_LABELS[low]) {
      elementsSet.add(low);
    }
  }

  const chaseTriggers: ChaseStateCode[] = [];
  if (Array.isArray(rawSkill.chaseFlags)) {
    for (const cf of rawSkill.chaseFlags) {
      const norm = normalizeChaseFlag(cf);
      if (norm && !chaseTriggers.includes(norm)) {
        chaseTriggers.push(norm);
      }
    }
  }

  const causesChaseStates = extractCausedChaseStates(descPlain, chaseTriggers);

  const damageCategories: string[] = [];
  const appliedEffects: string[] = [];
  const seenEffects = new Set<string>();

  const bracketRegex = /\[([^\]]{2,40})\]/g;
  let bMatch: RegExpExecArray | null;
  while ((bMatch = bracketRegex.exec(descPlain)) !== null) {
    const term = bMatch[1].trim();
    const low = term.toLowerCase();
    if (DAMAGE_CATEGORY_TERMS.has(low)) {
      if (!damageCategories.includes(term)) damageCategories.push(term);
      continue;
    }
    if (ELEMENT_BRACKET_TERMS.has(low)) {
      if (low === 'fogo') elementsSet.add('fire');
      else if (low === 'água' || low === 'agua') elementsSet.add('water');
      else if (low === 'vento') elementsSet.add('wind');
      else if (low === 'terra') elementsSet.add('earth');
      else if (low === 'trovão' || low === 'trovao' || low === 'relâmpago' || low === 'relampago' || low === 'raio') {
        elementsSet.add('thunder');
      }
      continue;
    }
    // Skip pure chase-state bracket terms (they are already exposed in chaseTriggers / causesChaseStates)
    if (detectChaseStateFromTerm(term)) continue;

    if (!seenEffects.has(low)) {
      seenEffects.add(low);
      appliedEffects.push(term);
    }
  }

  const effectIds = Array.isArray(rawSkill.effects)
    ? rawSkill.effects.map((e) => String(e || '').trim()).filter(Boolean)
    : [];

  let effectDescs: Record<string, string> | undefined;
  if (rawSkill.EffectDesc && typeof rawSkill.EffectDesc === 'object') {
    const out: Record<string, string> = {};
    for (const [lv, val] of Object.entries(rawSkill.EffectDesc as Record<string, unknown>)) {
      const resolved = resolveText ? resolveText(val) : String(val || '');
      const clean = stripHtmlTags(resolved);
      if (clean) out[lv] = clean;
    }
    if (Object.keys(out).length > 0) effectDescs = out;
  }

  const skillType =
    typeof rawSkill.type === 'number' && Number.isFinite(rawSkill.type)
      ? rawSkill.type
      : undefined;
  const actionFlags =
    typeof rawSkill.ActionFlags === 'string' && rawSkill.ActionFlags.trim()
      ? rawSkill.ActionFlags.trim()
      : undefined;

  return {
    ...(descResolved ? { desc: descResolved } : {}),
    ...(descPlain ? { descPlain } : {}),
    ...(descShort ? { descShort } : {}),
    ...(descInBattle ? { descInBattle } : {}),
    ...(skillType != null ? { skillType } : {}),
    ...(damageCategories.length > 0 ? { damageCategories } : {}),
    ...(elementsSet.size > 0 ? { elements: Array.from(elementsSet) } : {}),
    ...(rawFlags.length > 0 ? { targetFlags: rawFlags } : {}),
    ...(targetType ? { targetType, targetLabel } : {}),
    ...(actionFlags ? { actionFlags } : {}),
    ...(chaseTriggers.length > 0
      ? {
          chaseTriggers,
          chaseTriggerLabels: chaseTriggers.map((c) => CHASE_STATE_LABELS[c]),
        }
      : {}),
    ...(causesChaseStates.length > 0
      ? {
          causesChaseStates,
          causesChaseStateLabels: causesChaseStates.map((c) => CHASE_STATE_LABELS[c]),
        }
      : {}),
    ...(appliedEffects.length > 0 ? { appliedEffects } : {}),
    ...(effectIds.length > 0 ? { effectIds } : {}),
    ...(effectDescs ? { effectDescs } : {}),
  };
}

function numOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export function buildNinjaCombatProfile(
  heroObj: Record<string, unknown> | undefined,
  heroCode: string,
  displayName: string,
  skills: Record<string, NinjaSkillInfo>,
  passives: NinjaPassiveInfo[]
): NinjaCombatProfile | undefined {
  const initiators: NinjaChaseComboLink[] = [];
  const chasers: NinjaChaseComboLink[] = [];

  for (const [slot, sk] of Object.entries(skills)) {
    const hasTrigger = Boolean(sk.chaseTriggers && sk.chaseTriggers.length > 0);
    const hasCaused = Boolean(sk.causesChaseStates && sk.causesChaseStates.length > 0);
    if (hasTrigger) {
      chasers.push({
        slot,
        skillId: sk.id,
        skillName: sk.name,
        requiresStates: sk.chaseTriggers,
        requiresStateLabels: sk.chaseTriggerLabels,
        ...(hasCaused
          ? {
              causesStates: sk.causesChaseStates,
              causesStateLabels: sk.causesChaseStateLabels,
            }
          : {}),
        ...(sk.appliedEffects && sk.appliedEffects.length > 0
          ? { appliedEffects: sk.appliedEffects }
          : {}),
      });
    } else if (hasCaused) {
      initiators.push({
        slot,
        skillId: sk.id,
        skillName: sk.name,
        causesStates: sk.causesChaseStates,
        causesStateLabels: sk.causesChaseStateLabels,
        ...(sk.appliedEffects && sk.appliedEffects.length > 0
          ? { appliedEffects: sk.appliedEffects }
          : {}),
      });
    }
  }

  for (const p of passives) {
    const hasTrigger = Boolean(p.chaseTriggers && p.chaseTriggers.length > 0);
    const hasCaused = Boolean(p.causesChaseStates && p.causesChaseStates.length > 0);
    if (hasTrigger) {
      chasers.push({
        slot: 'passive',
        skillId: p.id,
        skillName: p.name,
        requiresStates: p.chaseTriggers,
        requiresStateLabels: p.chaseTriggerLabels,
        ...(hasCaused
          ? {
              causesStates: p.causesChaseStates,
              causesStateLabels: p.causesChaseStateLabels,
            }
          : {}),
        ...(p.appliedEffects && p.appliedEffects.length > 0
          ? { appliedEffects: p.appliedEffects }
          : {}),
      });
    }
  }

  if (!heroObj && initiators.length === 0 && chasers.length === 0) {
    return undefined;
  }

  const natureId = numOrUndefined(heroObj?.nature);
  const natureInfo = natureId != null ? NATURE_MAP[natureId] : undefined;
  const combatRole =
    typeof heroObj?.type === 'string' && heroObj.type.trim() ? heroObj.type.trim() : undefined;
  const rolePosition = stripHtmlTags(
    typeof heroObj?.position === 'string' ? heroObj.position : ''
  );
  const shortDesc = stripHtmlTags(
    typeof heroObj?.shortdesc === 'string' ? heroObj.shortdesc : ''
  );
  const tags = Array.isArray(heroObj?.flags)
    ? heroObj.flags.map((f) => String(f || '').trim()).filter(Boolean)
    : undefined;

  const baseStats: NinjaBaseStats | undefined = heroObj
    ? {
        hp: numOrUndefined(heroObj.lifenum),
        attack: numOrUndefined(heroObj.attacknum),
        defense: numOrUndefined(heroObj.defensenum),
        hpGrowth: numOrUndefined(heroObj.hp),
        attackGrowth: numOrUndefined(heroObj.attack),
        defenseGrowth: numOrUndefined(heroObj.defense),
        crit: numOrUndefined(heroObj.crit),
        uncrit: numOrUndefined(heroObj.uncrit),
        critDeepen: numOrUndefined(heroObj.critdeepen),
        block: numOrUndefined(heroObj.block),
        unblock: numOrUndefined(heroObj.unblock),
        blockDeepen: numOrUndefined(heroObj.blockdeepen),
        hurtBonus: numOrUndefined(heroObj.hurt),
        hurtReduction: numOrUndefined(heroObj.unhurt),
        skillRate: numOrUndefined(heroObj.skillrate),
        lifesteal: numOrUndefined(heroObj.suck),
        control: numOrUndefined(heroObj.ctrl),
        uncontrol: numOrUndefined(heroObj.unctrl),
        cure: numOrUndefined(heroObj.cure),
        ultimateDamage: numOrUndefined(heroObj.bishadamage),
        ultimateDefense: numOrUndefined(heroObj.bishadefense),
      }
    : undefined;

  const chakraAnger =
    heroObj && (heroObj.anger != null || heroObj.angerbase != null)
      ? {
          base: numOrUndefined(heroObj.angerbase),
          ...(heroObj.anger && typeof heroObj.anger === 'object'
            ? { rules: heroObj.anger as Record<string, unknown> }
            : {}),
        }
      : undefined;

  return {
    heroCode: heroCode || String(heroObj?.Id || ''),
    name: displayName || String(heroObj?.name || ''),
    ...(shortDesc ? { shortDesc } : {}),
    ...(rolePosition ? { rolePosition } : {}),
    ...(combatRole
      ? {
          combatRole,
          combatRoleLabel: COMBAT_ROLE_LABELS[combatRole] || combatRole,
        }
      : {}),
    ...(natureId != null
      ? {
          natureId,
          ...(natureInfo ? { nature: natureInfo.code, natureLabel: natureInfo.label } : {}),
        }
      : {}),
    ...(numOrUndefined(heroObj?.quality) != null ? { quality: numOrUndefined(heroObj?.quality) } : {}),
    ...(numOrUndefined(heroObj?.star) != null ? { star: numOrUndefined(heroObj?.star) } : {}),
    ...(numOrUndefined(heroObj?.maxStar) != null ? { maxStar: numOrUndefined(heroObj?.maxStar) } : {}),
    ...(typeof heroObj?.teamid === 'string' && heroObj.teamid.trim()
      ? { teamId: heroObj.teamid.trim() }
      : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(baseStats ? { baseStats } : {}),
    ...(chakraAnger ? { chakraAnger } : {}),
    chaseComboSummary: {
      initiators,
      chasers,
    },
  };
}

function normalizeChaseStateList(list: unknown): ChaseStateCode[] {
  if (!Array.isArray(list)) return [];
  const out: ChaseStateCode[] = [];
  for (const item of list) {
    const norm = normalizeChaseFlag(item);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * Re-evaluates and enriches `causesChaseStates` and `combatProfile.chaseComboSummary`
 * on a NinjaMediaProfile (including pre-baked profiles from `ninja-skills.json`),
 * ensuring attacks, skills, ultimates and continuing chases never retain `null` or missing
 * caused states when present in their kit description.
 */
export function enrichNinjaMediaProfileCombatData(
  profile: NinjaMediaProfile | null | undefined
): NinjaMediaProfile | null | undefined {
  if (!profile) return profile;

  const enrichedSkills: Record<string, NinjaSkillInfo> = {};
  for (const [slot, sk] of Object.entries(profile.skills || {})) {
    if (!sk) continue;
    const triggers = normalizeChaseStateList(sk.chaseTriggers);
    const existingCaused = normalizeChaseStateList(sk.causesChaseStates);
    const plainText = stripHtmlTags(sk.descPlain || sk.desc || sk.descShort || sk.descInBattle || '');
    const parsedCaused = extractCausedChaseStates(plainText, triggers);
    const mergedCaused = Array.from(new Set<ChaseStateCode>([...existingCaused, ...parsedCaused]));

    const nextSkill: NinjaSkillInfo = { ...sk };
    if (triggers.length > 0) {
      nextSkill.chaseTriggers = triggers;
      nextSkill.chaseTriggerLabels = triggers.map((c) => CHASE_STATE_LABELS[c]);
    } else {
      delete nextSkill.chaseTriggers;
      delete nextSkill.chaseTriggerLabels;
    }

    if (mergedCaused.length > 0) {
      nextSkill.causesChaseStates = mergedCaused;
      nextSkill.causesChaseStateLabels = mergedCaused.map((c) => CHASE_STATE_LABELS[c]);
    } else {
      delete nextSkill.causesChaseStates;
      delete nextSkill.causesChaseStateLabels;
    }

    enrichedSkills[slot] = nextSkill;
  }

  const enrichedPassives: NinjaPassiveInfo[] = (profile.passives || []).map((p) => {
    const triggers = normalizeChaseStateList(p.chaseTriggers);
    const existingCaused = normalizeChaseStateList(p.causesChaseStates);
    const plainText = stripHtmlTags(p.descPlain || p.desc || '');
    const parsedCaused = extractCausedChaseStates(plainText, triggers);
    const mergedCaused = Array.from(new Set<ChaseStateCode>([...existingCaused, ...parsedCaused]));

    const nextPassive: NinjaPassiveInfo = { ...p };
    if (triggers.length > 0) {
      nextPassive.chaseTriggers = triggers;
      nextPassive.chaseTriggerLabels = triggers.map((c) => CHASE_STATE_LABELS[c]);
    } else {
      delete nextPassive.chaseTriggers;
      delete nextPassive.chaseTriggerLabels;
    }

    if (mergedCaused.length > 0) {
      nextPassive.causesChaseStates = mergedCaused;
      nextPassive.causesChaseStateLabels = mergedCaused.map((c) => CHASE_STATE_LABELS[c]);
    } else {
      delete nextPassive.causesChaseStates;
      delete nextPassive.causesChaseStateLabels;
    }

    return nextPassive;
  });

  const initiators: NinjaChaseComboLink[] = [];
  const chasers: NinjaChaseComboLink[] = [];

  for (const [slot, sk] of Object.entries(enrichedSkills)) {
    const hasTrigger = Boolean(sk.chaseTriggers && sk.chaseTriggers.length > 0);
    const hasCaused = Boolean(sk.causesChaseStates && sk.causesChaseStates.length > 0);
    if (hasTrigger) {
      chasers.push({
        slot,
        skillId: sk.id,
        skillName: sk.name,
        requiresStates: sk.chaseTriggers,
        requiresStateLabels: sk.chaseTriggerLabels,
        ...(hasCaused
          ? {
              causesStates: sk.causesChaseStates,
              causesStateLabels: sk.causesChaseStateLabels,
            }
          : {}),
        ...(sk.appliedEffects && sk.appliedEffects.length > 0
          ? { appliedEffects: sk.appliedEffects }
          : {}),
      });
    } else if (hasCaused) {
      initiators.push({
        slot,
        skillId: sk.id,
        skillName: sk.name,
        causesStates: sk.causesChaseStates,
        causesStateLabels: sk.causesChaseStateLabels,
        ...(sk.appliedEffects && sk.appliedEffects.length > 0
          ? { appliedEffects: sk.appliedEffects }
          : {}),
      });
    }
  }

  for (const p of enrichedPassives) {
    const hasTrigger = Boolean(p.chaseTriggers && p.chaseTriggers.length > 0);
    const hasCaused = Boolean(p.causesChaseStates && p.causesChaseStates.length > 0);
    if (hasTrigger) {
      chasers.push({
        slot: 'passive',
        skillId: p.id,
        skillName: p.name,
        requiresStates: p.chaseTriggers,
        requiresStateLabels: p.chaseTriggerLabels,
        ...(hasCaused
          ? {
              causesStates: p.causesChaseStates,
              causesStateLabels: p.causesChaseStateLabels,
            }
          : {}),
        ...(p.appliedEffects && p.appliedEffects.length > 0
          ? { appliedEffects: p.appliedEffects }
          : {}),
      });
    }
  }

  const nextProfile: NinjaMediaProfile = {
    ...profile,
    skills: enrichedSkills,
    passives: enrichedPassives,
    ...(profile.combatProfile || initiators.length > 0 || chasers.length > 0
      ? {
          combatProfile: {
            ...(profile.combatProfile || {
              heroCode: profile.heroCode || profile.ninjaId || '',
              name: profile.displayName || profile.ninjaId || '',
            }),
            chaseComboSummary: {
              initiators,
              chasers,
            },
          },
        }
      : {}),
  };

  return nextProfile;
}

