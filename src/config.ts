import { ConfigProvider, Platform } from "tabby-core";

export type AIProvider = "openrouter" | "litellm";
export type PanelPosition = "left" | "right" | "top" | "bottom";

export interface AIAgentConfig {
  llmEndpoint: string;
  apiToken: string;
  model: string;
  autoApproveLowRiskCommands: boolean;
  additionalRequestParametersText: string;
  additionalRequestParameters: Record<string, any>;
  additionalSystemPrompt: string;
  panelPosition: PanelPosition;
  panelSizePercent: number;
  hideTerminalOutput: boolean;
}

export class AIAgentConfigProvider extends ConfigProvider {
  defaults = {
    aiAgent: {
      llmEndpoint: "",
      apiToken: "",
      model: "default",
      autoApproveLowRiskCommands: false,
      additionalRequestParametersText: "",
      additionalRequestParameters: {},
      additionalSystemPrompt: "",
      panelPosition: "right" as PanelPosition,
      panelSizePercent: 40,
      hideTerminalOutput: false,
    },
    hotkeys: {
      "toggle-ai-agent-panel": ["Ctrl-Alt-A"],
      "stop-ai-agent-response": ["Ctrl-Alt-S"],
      "approve-ai-agent-command": ["Ctrl-Alt-Enter"],
      "decline-ai-agent-command": ["Ctrl-Alt-Backspace"],
      "clear-ai-agent-chat": ["Ctrl-Alt-C"],
    },
  };

  platformDefaults = {
    [Platform.macOS]: {
      hotkeys: {
        "toggle-ai-agent-panel": ["Cmd-Shift-A"],
        "stop-ai-agent-response": ["Ctrl-Alt-S"],
        "approve-ai-agent-command": ["Cmd-Shift-Enter"],
        "decline-ai-agent-command": ["Cmd-Shift-Backspace"],
        "clear-ai-agent-chat": ["Cmd-Shift-C"],
      },
    },
  };
}
