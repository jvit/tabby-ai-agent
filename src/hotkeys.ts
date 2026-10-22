import { Injectable } from "@angular/core";
import {
  HotkeyDescription,
  HotkeyProvider,
  TranslateService,
} from "tabby-core";

@Injectable()
export class AIAgentHotkeyProvider extends HotkeyProvider {
  constructor(private translate: TranslateService) {
    super();
  }

  async provide(): Promise<HotkeyDescription[]> {
    return [
      {
        id: "toggle-ai-agent-panel",
        name: this.translate.instant("Toggle AI Agent Panel"),
      },
      {
        id: "stop-ai-agent-response",
        name: this.translate.instant("Stop AI Agent Response"),
      },
      {
        id: "approve-ai-agent-command",
        name: this.translate.instant("Approve AI Agent Command"),
      },
      {
        id: "decline-ai-agent-command",
        name: this.translate.instant("Decline AI Agent Command"),
      },
      {
        id: "clear-ai-agent-chat",
        name: this.translate.instant("Clear AI Agent Chat"),
      },
      {
        id: "force-read-terminal",
        name: this.translate.instant("Force Read Terminal"),
      },
    ];
  }
}
