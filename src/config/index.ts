// 設定 (v4): 素材 (sources / groups) とレシピ (profiles) の 2 層構成。
// 素材 = 接続先と metric の素性 (存在・format・閾値条件) を状況に依らず 1 つだけ持つ。
// レシピ = profile.view が「何を出すか・どう並べるか・10 行にどう置くか」を状況ごとに持つ。
// Phase 1 (MVP) は Default profile 1 個 (id 'default') に v3 の全構成を収容し activeProfileId 固定。

export {
  AIRQUALITY_SOURCE_ID,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SEG_LABELS,
  BUILTIN_SOURCE_ID,
  CONFIG_VERSION,
  CUSTOM_LABEL_PREFIX,
  DEFAULT_PROFILE_ID,
  GEOCODE_SOURCE_ID,
  GEOINFO_SOURCE_ID,
  LABEL_SEG,
  LOCAL_SOURCE_ID,
  LOCATION_PLACE_GROUP_ID,
  LOCATION_SOURCE_ID,
  LOCATION_WEATHER_GROUP_ID,
  PLACES_SOURCE_ID,
  RIGHT_DIVIDER,
  WEATHER_SOURCE_ID,
} from './constants'
export { emptyConfig } from './defaults'
export {
  customLabelId,
  customLabelKey,
  defaultShowGroupLabel,
  genLabelId,
  genPageId,
  genProfileId,
  genSourceId,
  isCustomLabelKey,
  isRightDivider,
  promoteSourceUrl,
  removeSourceUrl,
  setSourceUrls,
  sourceUrl,
  sourceUrls,
} from './ids'
export { generateGlassLayout } from './layout'
export { migrate } from './migration'
export { loadConfig, saveConfig, setConfigBridge } from './persistence'
export {
  activeProfile,
  activeView,
  addProfile,
  cloneGlassPage,
  duplicateActiveProfile,
  enabledSources,
  groupDisplayName,
  isSourceEnabled,
  removeProfile,
  renameProfile,
  resolvePages,
  setActiveProfile,
  setSourceEnabled,
  sourceById,
} from './profiles'
export { syncSourceWithStatus } from './source-sync'
export {
  addServer,
  ensureDefaultServer,
  reconcileSourceMachine,
  removeSource,
} from './sources'
export type {
  Config,
  GAlign,
  GlassGrid,
  GlassLayout,
  GlassPage,
  GridCellSpec,
  GridImageSpec,
  GroupMeta,
  GroupRef,
  OptionValues,
  Profile,
  ProfileView,
  RemovedSourceView,
  RemovedView,
  SegMeta,
  SourceDef,
  SourceKind,
  ViewGroup,
} from './types'
