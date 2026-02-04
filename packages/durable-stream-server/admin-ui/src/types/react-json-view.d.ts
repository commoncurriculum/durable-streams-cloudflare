declare module "react-json-view" {
  import type { ComponentType } from "react";

  interface ReactJsonProps {
    src: object | unknown[];
    name?: string | false | null;
    theme?: string | object;
    collapsed?: boolean | number;
    collapseStringsAfterLength?: number;
    displayDataTypes?: boolean;
    displayObjectSize?: boolean;
    enableClipboard?: boolean | ((copy: { src: unknown; namespace: string[] }) => void);
    indentWidth?: number;
    iconStyle?: "circle" | "triangle" | "square";
    onAdd?: (add: { existing_src: object; new_value: unknown; updated_src: object; name: string; namespace: string[] }) => void;
    onEdit?: (edit: { existing_src: object; new_value: unknown; updated_src: object; existing_value: unknown; name: string; namespace: string[] }) => void;
    onDelete?: (del: { existing_src: object; updated_src: object; existing_value: unknown; name: string; namespace: string[] }) => void;
    onSelect?: (select: { name: string; namespace: string[]; value: unknown }) => void;
    sortKeys?: boolean;
    quotesOnKeys?: boolean;
    validationMessage?: string;
    style?: React.CSSProperties;
  }

  const ReactJson: ComponentType<ReactJsonProps>;
  export default ReactJson;
}
