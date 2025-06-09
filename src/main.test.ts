import * as core from "@actions/core";
import * as main from "./main";

const runMock = jest.spyOn(main, "run");

const timeRegex = /^\d{2}:\d{2}:\d{2}/;

let debugMock: jest.SpiedFunction<typeof core.debug>;
let errorMock: jest.SpiedFunction<typeof core.error>;
let getInputMock: jest.SpiedFunction<typeof core.getInput>;
let setFailedMock: jest.SpiedFunction<typeof core.setFailed>;
let setOutputMock: jest.SpiedFunction<typeof core.setOutput>;

describe("action", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        debugMock = jest.spyOn(core, "debug").mockImplementation();
        errorMock = jest.spyOn(core, "error").mockImplementation();
        getInputMock = jest.spyOn(core, "getInput").mockImplementation();
        setFailedMock = jest.spyOn(core, "setFailed").mockImplementation();
        setOutputMock = jest.spyOn(core, "setOutput").mockImplementation();
    });

    it("sets the time output", async () => {
        getInputMock.mockImplementation((name) => {
            switch (name) {
                case "milliseconds":
                    return "500";
                default:
                    return "";
            }
        });

        await main.run();
        expect(runMock).toHaveReturned();

        expect(debugMock).toHaveBeenNthCalledWith(1, "Waiting 500 milliseconds ...");
        expect(debugMock).toHaveBeenNthCalledWith(2, expect.stringMatching(timeRegex));
        expect(debugMock).toHaveBeenNthCalledWith(3, expect.stringMatching(timeRegex));
        expect(setOutputMock).toHaveBeenNthCalledWith(1, "time", expect.stringMatching(timeRegex));
        expect(errorMock).not.toHaveBeenCalled();
    });

    it("sets a failed status", async () => {
        getInputMock.mockImplementation((name) => {
            switch (name) {
                case "milliseconds":
                    return "this is not a number";
                default:
                    return "";
            }
        });

        await main.run();
        expect(runMock).toHaveReturned();

        expect(setFailedMock).toHaveBeenNthCalledWith(1, "milliseconds not a number");
        expect(errorMock).not.toHaveBeenCalled();
    });
});
