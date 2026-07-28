import { Component, HostBinding, OnInit } from "@angular/core";
import { ConfigService } from "tabby-core";
import { PanelPosition } from "../config";
import { checkpointLLMEndpoint } from "../lib/llm_chat_session";
import { normalizeOpenAIBaseUrl } from "../lib/llm_endpoint";

@Component({
  templateUrl: "./agent_settings.html",
  styleUrls: ["./agent_settings.scss"],
})
export class AIAgentSettingsComponent implements OnInit {
  additionalSystemPrompt = "";
  @HostBinding("class.content-box") true;
  apiToken = "";
  model = "default";
  additionalRequestParametersText = "";
  additionalRequestParametersError: string | null = null;
  panelPosition: PanelPosition = "right";
  panelSizePercent = 40;
  endpointCheckpointStatus:
    | "idle"
    | "checking"
    | "valid"
    | "invalid"
    | "empty" = "idle";
  endpointCheckpointMessage = "";
  private endpointCheckpointSequence = 0;

  constructor(public config: ConfigService) {}

  ngOnInit(): void {
    this.ensureConfigDefaults();
    this.apiToken = this.config.store.aiAgent.apiToken;
    this.model = this.config.store.aiAgent.model;
    this.additionalSystemPrompt = this.config.store.aiAgent.additionalSystemPrompt;
    this.additionalRequestParametersText =
      this.config.store.aiAgent.additionalRequestParametersText;
    this.panelPosition = this.config.store.aiAgent.panelPosition ?? "right";
    this.panelSizePercent = this.config.store.aiAgent.panelSizePercent ?? 40;
  }

  async saveLLMEndpoint(value: string): Promise<void> {
    const endpoint = this.normalizeEndpoint(value);
    this.config.store.aiAgent.llmEndpoint = endpoint;
    await this.config.save();
  }

  async saveApiToken(value: string): Promise<void> {
    this.apiToken = value;
    this.config.store.aiAgent.apiToken = value;
    await this.config.save();
  }

  async saveModel(value: string): Promise<void> {
    const model = value.trim() || "default";
    this.model = model;
    this.config.store.aiAgent.model = model;
    await this.config.save();
  }

  checkLLMEndpoint(): void {
    this.startEndpointCheckpoint(
      this.config.store.aiAgent.llmEndpoint,
      this.config.store.aiAgent.apiToken,
      this.config.store.aiAgent.model,
    );
  }

  async saveAutoApproveLowRiskCommands(value: boolean): Promise<void> {
    this.config.store.aiAgent.autoApproveLowRiskCommands = value;
    await this.config.save();
  }

  async saveAdditionalSystemPrompt(value: string): Promise<void> {
    this.additionalSystemPrompt = value;
    this.config.store.aiAgent.additionalSystemPrompt = value;
    await this.config.save();
  }

  async saveAdditionalRequestParametersText(value: string): Promise<void> {
    this.additionalRequestParametersText = value;

    const parsed = this.parseAdditionalRequestParameters(value);
    if (!parsed.ok) {
      this.additionalRequestParametersError = parsed.error;
      return;
    }

    this.additionalRequestParametersError = null;
    this.config.store.aiAgent.additionalRequestParametersText = value;
    this.config.store.aiAgent.additionalRequestParameters = parsed.value;
    await this.config.save();
  }

  async savePanelPosition(value: PanelPosition): Promise<void> {
    this.panelPosition = value;
    this.config.store.aiAgent.panelPosition = value;
    await this.config.save();
  }

  async savePanelSizePercent(value: number): Promise<void> {
    const clamped = Math.min(90, Math.max(10, Math.round(value)));
    this.panelSizePercent = clamped;
    this.config.store.aiAgent.panelSizePercent = clamped;
    await this.config.save();
  }

  async saveHideTerminalOutput(value: boolean): Promise<void> {
    this.config.store.aiAgent.hideTerminalOutput = value;
    await this.config.save();
  }

  private ensureConfigDefaults(): void {
    this.config.store.aiAgent ??= {};
    this.config.store.aiAgent.llmEndpoint ??= "";
    this.config.store.aiAgent.apiToken ??= "";
    this.config.store.aiAgent.model ??= "default";
    this.config.store.aiAgent.autoApproveLowRiskCommands ??= false;
    this.config.store.aiAgent.additionalRequestParametersText ??= "";
    this.config.store.aiAgent.additionalRequestParameters ??= {};
    this.config.store.aiAgent.additionalSystemPrompt ??= "";
    this.config.store.aiAgent.panelPosition ??= "right";
    this.config.store.aiAgent.panelSizePercent ??= 40;
    this.config.store.aiAgent.hideTerminalOutput ??= false;
  }

  private normalizeEndpoint(value: string): string {
    return normalizeOpenAIBaseUrl(value);
  }

  private startEndpointCheckpoint(
    endpoint: string,
    apiToken: string,
    model: string,
  ): void {
    const sequence = ++this.endpointCheckpointSequence;
    if (!endpoint) {
      this.endpointCheckpointStatus = "empty";
      this.endpointCheckpointMessage = "Add a base URL to check the endpoint.";
      return;
    }

    this.endpointCheckpointStatus = "checking";
    this.endpointCheckpointMessage = "Checking endpoint...";
    void this.checkEndpoint(endpoint, apiToken, model, sequence);
  }

  private async checkEndpoint(
    endpoint: string,
    apiToken: string,
    model: string,
    sequence: number,
  ): Promise<void> {
    try {
      await checkpointLLMEndpoint(endpoint, apiToken, model);
      if (sequence !== this.endpointCheckpointSequence) {
        return;
      }

      this.endpointCheckpointStatus = "valid";
      this.endpointCheckpointMessage = "Endpoint accepted the checkpoint request.";
    } catch (error) {
      if (sequence !== this.endpointCheckpointSequence) {
        return;
      }

      this.endpointCheckpointStatus = "invalid";
      this.endpointCheckpointMessage =
        error instanceof Error
          ? error.message
          : "Endpoint checkpoint request failed.";
    }
  }

  private parseAdditionalRequestParameters(
    value: string,
  ):
    | { ok: true; value: Record<string, any> }
    | { ok: false; error: string } {
    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: true, value: {} };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!this.isPlainObject(parsed)) {
        return {
          ok: false,
          error: "Additional request parameters must be a JSON object.",
        };
      }

      return { ok: true, value: parsed };
    } catch {
      return {
        ok: false,
        error: "Additional request parameters must be valid JSON.",
      };
    }
  }

  private isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
