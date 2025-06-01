module.exports = {
    verbose: true,
    clearMocks: true,
    collectCoverageFrom: ["src/**/*.ts"],
    testEnvironment: "node",
    testMatch: ["**/*.test.ts"],
    testPathIgnorePatterns: ["/node_modules/", "/dist/"],
    moduleFileExtensions: ["ts", "js"],
    transform: {
        "^.+\\.ts$": "ts-jest",
    },
    watchPlugins: ["jest-watch-typeahead/filename", "jest-watch-typeahead/testname"],
};
