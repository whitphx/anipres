import { defaultShapeUtils, defaultBindingUtils } from "tldraw";
import { SlideShapeUtil } from "./shapes/slide/SlideShapeUtil";
import { ThemeImageShapeUtil } from "./shapes/theme-image/ThemeImageShapeUtil";

export const customShapeUtils = [SlideShapeUtil, ThemeImageShapeUtil];

export const allShapeUtils = [...defaultShapeUtils, ...customShapeUtils];
export const allBindingUtils = [...defaultBindingUtils];
