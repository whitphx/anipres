import { useEffect, useState, useCallback, memo } from "react";
import { useContainer } from "tldraw";

// See FrameEditor.module.scss for the CSS variables that need to be delegated.
const DELEGATED_CSS_VARS = [
  "--color-background",
  "--color-text",
  "--color-selection-stroke",
  "--color-divider",
  "--color-low-border",
  "--color-primary",
  "--space-4",
] as const;

/**
 * This component is used to delegate some CSS variables from the Tldraw container to the children.
 * This is necessary because a FrameEditor element is mounted in a Portal for DnD, and the CSS
 * variables are not automatically propagated to the Portal,
 * while the FrameEditor element refers to these CSS variables for its styling.
 */
export const DelegateTldrawCssVars = memo((props: React.PropsWithChildren) => {
  const container = useContainer();

  const getCssVars = useCallback(() => {
    const computedStyle = window.getComputedStyle(container);
    return DELEGATED_CSS_VARS.reduce(
      (acc, cssVar) => {
        acc[cssVar] = computedStyle.getPropertyValue(cssVar);
        return acc;
      },
      {} as Record<(typeof DELEGATED_CSS_VARS)[number], string>,
    );
  }, [container]);

  const [cssVars, setCssVars] = useState<Record<string, string>>(getCssVars());

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setCssVars(getCssVars());
    });
    observer.observe(container, {
      attributeFilter: ["class"], // Tldraw switches light and dark themes by attaching a class to the container.
    });
    return () => observer.disconnect();
  }, [container, getCssVars]);

  return <div style={cssVars}>{props.children}</div>;
});
DelegateTldrawCssVars.displayName = "DelegateTldrawCssVars";
