export type SpinePackageKind = 'character' | 'summon_skin' | 'effect';

export interface NinjaEntry {
  id: string;
  code: string;
  name?: string;
  nameArtUrl?: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  atlasUrl: string;
  skeletonUrl: string;
  kind?: SpinePackageKind;
  sourceIndex?: 'spine-hd' | 'spine-astc' | 'code';
  hasVideo?: boolean;
}

export interface SheetEntry {
  name: string;
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
  sheetKind?: 'astc_sheet' | 'spine_sheet';
}

export type GameAssetCategory = 'emoji' | 'hero' | 'item' | 'ui' | 'bg' | 'sprite' | 'other';

export interface GameAssetEntry {
  name: string;
  url: string;
  category: GameAssetCategory;
  ext: string;
}

export interface ScanStats {
  scannedScripts: number;
  discoveredAssets: number;
  totalNinjas: number;
  totalSheets: number;
  elapsedMs: number;
}

export interface ExtractResponse {
  sourceUrl: string;
  resolvedGameUrl: string;
  gameTitle: string;
  ninjas: NinjaEntry[];
  sheets: SheetEntry[];
  assets: GameAssetEntry[];
  stats: ScanStats;
}

export interface AtlasRegion {
  name: string;
  pageName: string;
  rotate: number; // 0 or 90 (degrees)
  x: number;
  y: number;
  width: number;
  height: number;
  origWidth: number;
  origHeight: number;
  offsetX: number;
  offsetY: number;
  index: number;
}

export interface AtlasPage {
  name: string;
  width: number;
  height: number;
  format?: string;
  filter?: string;
  repeat?: string;
  regions: AtlasRegion[];
}

export interface SpineAttachmentInfo {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  name?: string;
  path?: string;
}

export interface SpineBoneDef {
  name: string;
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
}

export interface SpineSlotDef {
  name: string;
  bone: string;
  attachment?: string;
  color?: string;
  blend?: string;
}

export interface SpineAnimationData {
  slots?: Record<
    string,
    {
      attachment?: Array<{ time?: number; name?: string | null }>;
      color?: Array<{ time?: number; color?: string; curve?: unknown }>;
      twoColor?: Array<{ time?: number; light?: string; dark?: string; curve?: unknown }>;
    }
  >;
  bones?: Record<
    string,
    {
      rotate?: Array<{ time?: number; angle?: number; curve?: unknown }>;
      translate?: Array<{ time?: number; x?: number; y?: number; curve?: unknown }>;
      scale?: Array<{ time?: number; x?: number; y?: number; curve?: unknown }>;
      shear?: Array<{ time?: number; x?: number; y?: number; curve?: unknown }>;
    }
  >;
  events?: Array<{ time?: number; name?: string; string?: string }>;
}

export interface SpineCommandEffectRef {
  spineId: string;
  animName: string;
  startTime: number;
  layer: 'behind' | 'front';
  isSelfOrScreen: boolean;
  loop: boolean;
  rawCommand: string;
}

export interface SpineAudioEventRef {
  soundName: string;
  time: number;
  source: 'cmd' | 'event';
}

export interface SpineVideoEventRef {
  source: string;
  resolvedName: string;
  time: number;
  careforward: boolean;
  layer: string;
  rawCommand: string;
}

export interface SpineShowFeatureRef {
  files: string[];
  mainFile: string;
  time: number;
  rawCommand: string;
}

export interface PassiveAuraLayerDef {
  layer: 'behind' | 'front';
  introAnim?: string;
  loopAnim: string;
  outroAnim?: string;
}

export interface PassiveAuraDef {
  id: string;
  label: string;
  atlasUrl: string;
  skeletonUrl: string;
  layers: PassiveAuraLayerDef[];
}

export type ChaseStateCode = 'fall' | 'popup' | 'launcher' | 'back';

export type SkillTargetType =
  | 'single_enemy'
  | 'enemy_row'
  | 'enemy_col'
  | 'all_enemies'
  | 'multi_enemy_3'
  | 'random_enemies'
  | 'all_allies'
  | 'self_or_custom';

export interface NinjaSkillInfo {
  id: string;
  animKey: string;
  slotLabel: string;
  name: string;
  desc?: string;
  descPlain?: string;
  descShort?: string;
  descInBattle?: string;
  iconName?: string;
  iconUrl?: string;
  skillType?: number;
  damageCategories?: string[];
  elements?: string[];
  targetFlags?: string[];
  targetType?: SkillTargetType;
  targetLabel?: string;
  actionFlags?: string;
  chaseTriggers?: ChaseStateCode[];
  chaseTriggerLabels?: string[];
  causesChaseStates?: ChaseStateCode[];
  causesChaseStateLabels?: string[];
  appliedEffects?: string[];
  effectIds?: string[];
  effectDescs?: Record<string, string>;
}

export interface NinjaPassiveInfo {
  id: string;
  name: string;
  desc?: string;
  descPlain?: string;
  iconName?: string;
  iconUrl?: string;
  skillType?: number;
  targetFlags?: string[];
  chaseTriggers?: ChaseStateCode[];
  chaseTriggerLabels?: string[];
  causesChaseStates?: ChaseStateCode[];
  causesChaseStateLabels?: string[];
  appliedEffects?: string[];
  effectIds?: string[];
  effectDescs?: Record<string, string>;
}

export interface NinjaChaseComboLink {
  slot: string;
  skillId: string;
  skillName: string;
  requiresStates?: ChaseStateCode[];
  requiresStateLabels?: string[];
  causesStates?: ChaseStateCode[];
  causesStateLabels?: string[];
  appliedEffects?: string[];
}

export interface NinjaBaseStats {
  hp?: number;
  attack?: number;
  defense?: number;
  hpGrowth?: number;
  attackGrowth?: number;
  defenseGrowth?: number;
  crit?: number;
  uncrit?: number;
  critDeepen?: number;
  block?: number;
  unblock?: number;
  blockDeepen?: number;
  hurtBonus?: number;
  hurtReduction?: number;
  skillRate?: number;
  lifesteal?: number;
  control?: number;
  uncontrol?: number;
  cure?: number;
  ultimateDamage?: number;
  ultimateDefense?: number;
}

export interface NinjaCombatProfile {
  heroCode: string;
  name: string;
  shortDesc?: string;
  rolePosition?: string;
  combatRole?: string;
  combatRoleLabel?: string;
  natureId?: number;
  nature?: string;
  natureLabel?: string;
  quality?: number;
  star?: number;
  maxStar?: number;
  teamId?: string;
  tags?: string[];
  baseStats?: NinjaBaseStats;
  chakraAnger?: {
    base?: number;
    rules?: Record<string, unknown>;
  };
  chaseComboSummary: {
    initiators: NinjaChaseComboLink[];
    chasers: NinjaChaseComboLink[];
  };
}

export interface NinjaVoiceClip {
  key: string;
  category: string;
  label: string;
  url: string;
}

export interface NinjaVideoClip {
  key: string;
  label: string;
  kind: 'ultimate' | 'recruit';
  animName?: string;
  startTime?: number;
  url: string;
}

export interface NinjaMediaProfile {
  ninjaId: string;
  heroCode?: string;
  displayName?: string;
  combatProfile?: NinjaCombatProfile;
  skills: Record<string, NinjaSkillInfo>;
  passives: NinjaPassiveInfo[];
  passiveAura: PassiveAuraDef | null;
  videos: NinjaVideoClip[];
  voices: NinjaVoiceClip[];
  soundUrlMap: Record<string, string>;
  videoUrlMap: Record<string, string>;
  originBase: string;
}

export interface AtlasRegionSprite {
  kind: 'atlas-region';
  image: HTMLImageElement;
  region: AtlasRegion;
  width: number;
  height: number;
}

export type SpriteRegionSource = HTMLCanvasElement | AtlasRegionSprite;

export interface CompositeSpineLayer {
  spineId: string;
  skeleton: SpineSkeleton;
  animName: string;
  regionCanvasMap: Map<string, SpriteRegionSource>;
  startTime: number;
  duration: number;
  layer: 'behind' | 'front';
  loop: boolean;
  isSelfOrScreen?: boolean;
}

export interface SpineSkeleton {
  skeleton?: {
    hash?: string;
    spine?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fps?: number;
  };
  bones?: SpineBoneDef[];
  slots?: SpineSlotDef[];
  skins?: Array<{
    name: string;
    attachments?: Record<string, Record<string, SpineAttachmentInfo>>;
  }> | Record<string, Record<string, Record<string, SpineAttachmentInfo>>>;
  animations?: Record<string, SpineAnimationData>;
}

export interface NinjaBundleResponse {
  atlasText: string;
  skeleton: SpineSkeleton | null;
  pageUrls: Record<string, string>;
  idleFrameName?: string;
}

export interface SlicedFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  rotate: number;
  dataUrl: string;
}
