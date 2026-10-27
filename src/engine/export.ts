/** Compatibility entry point for the original MP4 export API. */
export {
  exportMp4,
  exportMp4 as exportVideo,
} from "./export/formats/mp4/export-mp4";
export type { ExportOptions, ExportStage } from "./export/types";
export {
  encodeAac,
  AAC_FRAME_SAMPLES,
  AAC_BITRATE,
  AAC_CODEC,
  AAC_PRIMING_SAMPLES,
} from "./export/codecs/aac";
