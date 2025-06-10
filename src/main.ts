import * as core from "@actions/core";
import { runLabelMode } from "./label";
import { Input, RunMode } from "./types";
import { runReportMode } from "./report";

export async function run(): Promise<void> {
    try {
        const runMode = core.getInput(Input.RUN_MODE, { required: true }) as RunMode | undefined;
        switch (runMode) {
            case RunMode.LABEL:
                await runLabelMode();
                break;
            case RunMode.REPORT:
                await runReportMode();
                break;
            default:
                core.setFailed(`Unsupported run mode: ${runMode}`);
                break;
        }
    } catch (error) {
        core.setFailed("Failed to run the actionnnnn: " + (error instanceof Error ? error.message : String(error)));
    }
}
