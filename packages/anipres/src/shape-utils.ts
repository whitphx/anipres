import { defaultShapeUtils, defaultBindingUtils } from "tldraw";
import { SlideShapeUtil } from "./shapes/slide/SlideShapeUtil";
import { ThemeImageShapeUtil } from "./shapes/theme-image/ThemeImageShapeUtil";
import { YouTubeEmbedShapeUtil } from "./shapes/youtube-embed/YouTubeEmbedShapeUtil";
import { MediaControlShapeUtil } from "./shapes/media-control/MediaControlShapeUtil";

export const customShapeUtils = [
  SlideShapeUtil,
  ThemeImageShapeUtil,
  YouTubeEmbedShapeUtil,
  MediaControlShapeUtil,
];
export const customBindingUtils = [];

export const allShapeUtils = [...defaultShapeUtils, ...customShapeUtils];
export const allBindingUtils = [...defaultBindingUtils, ...customBindingUtils];
