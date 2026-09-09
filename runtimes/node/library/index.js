const { stateNode } = require("./state_process");

const STATIC_REGISTRY = {
    "log": {
        id: "debug/log",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const logStuff = input.log || state.log || state.ghost || "Hey Buddy! Nothing to log";
            console.log("Log ->>>", logStuff);
            returnCallback({
                output: logStuff,
                state // not updating the state to avoid cache like echo
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "log",
            description: "logging the input on runtime's console",
            tags: ["debug", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "log": {
                    type: "any",
                    description: "data to be logged",
                    required: true,
                    default: ""
                }
            },
            outputs: {
                "log": {
                    type: "any",
                    description: "logged data"
                }
            }
        }
    },

    "state": {
        id: "memory/state",
        artifactType: "process",
        sourceType: "application/javascript",
        interface: {
            inputs: {
                "key": {
                    type: "string",
                    description: "Set key of the state",
                    required: true,
                    default: "key"
                },
                "value": {
                    type: "any",
                    description: "Set value to be stored in the state",
                    required: true,
                    default: "value"
                },
                // temperaily out of scope
                /* "namespace": {
                    type: "string",
                    description: "Set namespace of the state",
                    required: true,
                    default: "default"
                } */
            },
            outputs: {
                "key": {
                    type: "string",
                    description: "Read key of the state"
                },
                "value": {
                    type: "any",
                    description: "Read value of the state"
                }
            }
        },
        source: async (input, nodeState, returnCallback) => {
            // update the state, and state node
            stateNode.compute(input, nodeState, ({ output, state }) => {
                // update the state node
                nodeState = state;
                // return the output
                returnCallback({
                    output,
                    nodeState
                });
            });
        }
    },

    "if-else": {
        id: "flow/if-else",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const port = input.condition ? "true" : "false";
            returnCallback({
                output: { [port]: input.value },
                state // stateless — condition is evaluated fresh every run
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "if-else",
            description: "routes the input value down the true or false port based on a boolean condition",
            tags: ["flow-control", "branch"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "any",
                    description: "data to forward down whichever branch fires",
                    required: true,
                    default: null
                },
                "condition": {
                    type: "boolean",
                    description: "which branch to take",
                    required: true,
                    default: true
                }
            },
            outputs: {
                "true": {
                    type: "any",
                    description: "value, present only when condition was true"
                },
                "false": {
                    type: "any",
                    description: "value, present only when condition was false"
                }
            }
        }
    },

    "switch": {
        id: "flow/switch",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const cases = input.cases || {};
            const key = String(input.value);
            const port = Object.prototype.hasOwnProperty.call(cases, key)
                ? cases[key]
                : (input.defaultPort || "default");
            returnCallback({
                output: { [port]: input.value },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "switch",
            description: "routes the input value to a named port chosen by matching it against a case map, falling back to a default port",
            tags: ["flow-control", "branch", "router"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "any",
                    description: "value to match against cases",
                    required: true,
                    default: null
                },
                "cases": {
                    type: "object",
                    description: "map of stringified value -> output port name, e.g. { \"gold\": \"vip\", \"silver\": \"standard\" }",
                    required: true,
                    default: {}
                },
                "defaultPort": {
                    type: "string",
                    description: "port used when value matches no case",
                    required: false,
                    default: "default"
                }
            },
            outputs: {
                "*": {
                    type: "any",
                    description: "value, published under whichever port name matched (dynamic key, not fixed in advance)"
                }
            }
        }
    },

    "filter": {
        id: "flow/filter",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const port = input.predicate ? "pass" : "dropped";
            returnCallback({
                output: { [port]: input.value },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "filter",
            description: "forwards the input value on the pass port when predicate is true, otherwise on the dropped port",
            tags: ["flow-control", "filter"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "any",
                    description: "data to conditionally forward",
                    required: true,
                    default: null
                },
                "predicate": {
                    type: "boolean",
                    description: "whether the item passes the filter (computed upstream, e.g. by an expression node)",
                    required: true,
                    default: true
                }
            },
            outputs: {
                "pass": {
                    type: "any",
                    description: "value, present only when predicate was true"
                },
                "dropped": {
                    type: "any",
                    description: "value, present only when predicate was false"
                }
            }
        }
    },

    "merge": {
        id: "flow/merge",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            // The node container already combines every subscribed upstream
            // output into this single input object before calling source(),
            // so merge's job is just to publish that combined object as one
            // value under a single output key for downstream consumption.
            returnCallback({
                output: { merged: { ...input } },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "merge",
            description: "combines all subscribed input branches into a single merged output object once every branch has resolved",
            tags: ["flow-control", "merge", "join"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "*": {
                    type: "any",
                    description: "one or more named branch inputs, wired up per-graph (dynamic keys, not fixed in advance)",
                    required: true,
                    default: {}
                }
            },
            outputs: {
                "merged": {
                    type: "object",
                    description: "single object containing every input key"
                }
            }
        }
    },

    "delay": {
        id: "flow/delay",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const ms = Number(input.ms) || 0;
            setTimeout(() => {
                returnCallback({
                    output: { value: input.value },
                    state
                });
            }, ms);
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "delay",
            description: "holds the input value for a fixed duration before publishing it, without blocking the worker",
            tags: ["flow-control", "timing"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "any",
                    description: "data to forward after the delay",
                    required: true,
                    default: null
                },
                "ms": {
                    type: "number",
                    description: "delay duration in milliseconds",
                    required: true,
                    default: 1000
                }
            },
            outputs: {
                "value": {
                    type: "any",
                    description: "the same value, published after ms has elapsed"
                }
            }
        }
    },

    "rate-limit": {
        id: "flow/rate-limit",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const now = Date.now();
            const limitMs = Number(input.limitMs) || 1000;
            const lastRun = state?.lastRun || 0;

            if (now - lastRun >= limitMs) {
                returnCallback({
                    output: { pass: input.value },
                    state: { ...state, lastRun: now } // persisted — the throttle window depends on it
                });
            } else {
                returnCallback({
                    output: { throttled: input.value },
                    state // unchanged — this run didn't consume the window
                });
            }
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "rate-limit",
            description: "allows the value through on the pass port at most once per limitMs window, otherwise routes it to the throttled port",
            tags: ["flow-control", "throttle", "stateful"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "any",
                    description: "data to conditionally forward",
                    required: true,
                    default: null
                },
                "limitMs": {
                    type: "number",
                    description: "minimum milliseconds between passes",
                    required: true,
                    default: 1000
                }
            },
            outputs: {
                "pass": {
                    type: "any",
                    description: "value, present only when the window had elapsed"
                },
                "throttled": {
                    type: "any",
                    description: "value, present only when the window had not yet elapsed"
                }
            }
        }
    },

    "add": {
        id: "math/add",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.a || 0);
            const b = Number(input.b || 0);
            returnCallback({
                output: {
                    sum: a + b,
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "add",
            description: "adds two numbers",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "a": {
                    type: "number",
                    description: "first number",
                    required: true,
                    default: 0
                },
                "b": {
                    type: "number",
                    description: "second number",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "sum": {
                    type: "number",
                    description: "result of a + b"
                }
            }
        }
    },

    "subtract": {
        id: "math/subtract",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.a || 0);
            const b = Number(input.b || 0);
            returnCallback({
                output: {
                    difference: a - b,
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "subtract",
            description: "subtracts the second number from the first",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "a": {
                    type: "number",
                    description: "minuend",
                    required: true,
                    default: 0
                },
                "b": {
                    type: "number",
                    description: "subtrahend",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "difference": {
                    type: "number",
                    description: "result of a - b"
                }
            }
        }
    },

    "multiply": {
        id: "math/multiply",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.a || 1);
            const b = Number(input.b || 1);
            returnCallback({
                output: {
                    product: a * b,
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "multiply",
            description: "multiplies two numbers",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "a": {
                    type: "number",
                    description: "first factor",
                    required: true,
                    default: 1
                },
                "b": {
                    type: "number",
                    description: "second factor",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "product": {
                    type: "number",
                    description: "result of a * b"
                }
            }
        }
    },

    "divide": {
        id: "math/divide",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.numerator || 0);
            const b = Number(input.denominator || 1);
            if (b === 0) {
                returnCallback({
                    output: { error: "division by zero" },
                    state
                });
                return;
            }
            returnCallback({
                output: {
                    quotient: a / b
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "divide",
            description: "divides the numerator by the denominator (safe against division by zero)",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "numerator": {
                    type: "number",
                    description: "dividend",
                    required: true,
                    default: 0
                },
                "denominator": {
                    type: "number",
                    description: "divisor",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "quotient": {
                    type: "number",
                    description: "result of numerator / denominator"
                },
                "error": {
                    type: "string",
                    description: "an error message if division by zero occurs"
                }
            }
        }
    },

    "abs": {
        id: "math/abs",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const n = Number(input.value || 0);
            returnCallback({
                output: {
                    result: Math.abs(n)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "absolute value",
            description: "returns the absolute value of a number",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "input number",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "absolute value"
                }
            }
        }
    },

    "mod": {
        id: "math/modulo",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.dividend || 0);
            const b = Number(input.divisor || 1);
            if (b === 0) {
                returnCallback({
                    output: { error: "division by zero" },
                    state
                });
                return;
            }
            returnCallback({
                output: {
                    remainder: a % b
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "modulo",
            description: "returns the remainder of a division",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "dividend": {
                    type: "number",
                    description: "number to be divided",
                    required: true,
                    default: 0
                },
                "divisor": {
                    type: "number",
                    description: "number to divide by",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "remainder": {
                    type: "number",
                    description: "remainder of the division"
                },
                "error": {
                    type: "string",
                    description: "an error message if division by zero occurs"
                }
            }
        }
    },

    "power": {
        id: "math/power",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const base = Number(input.base || 0);
            const exponent = Number(input.exponent || 0);
            returnCallback({
                output: {
                    result: Math.pow(base, exponent)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "power",
            description: "raises the base to the power of the exponent",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "base": {
                    type: "number",
                    description: "base number",
                    required: true,
                    default: 0
                },
                "exponent": {
                    type: "number",
                    description: "exponent",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "result of base raised to the power of exponent"
                }
            }
        }
    },

    "min": {
        id: "math/min",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const values = Array.isArray(input.values)
                ? input.values
                : Object.values(input).filter(v => typeof v === "number");
            if (!values.length) {
                returnCallback({
                    output: { error: "no numbers provided" },
                    state
                });
                return;
            }
            returnCallback({
                output: {
                    result: Math.min(...values)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "minimum",
            description: "returns the minimum of one or more numbers",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "values": {
                    type: "array",
                    description: "array of numbers",
                    required: true,
                    default: []
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "minimum value"
                },
                "error": {
                    type: "string",
                    description: "an error message if no numbers are provided"
                }
            }
        }
    },

    "max": {
        id: "math/max",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const values = Array.isArray(input.values)
                ? input.values
                : Object.values(input).filter(v => typeof v === "number");
            if (!values.length) {
                returnCallback({
                    output: { error: "no numbers provided" },
                    state
                });
                return;
            }
            returnCallback({
                output: {
                    result: Math.max(...values)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "maximum",
            description: "returns the maximum of one or more numbers",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "values": {
                    type: "array",
                    description: "array of numbers",
                    required: true,
                    default: []
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "maximum value"
                },
                "error": {
                    type: "string",
                    description: "an error message if no numbers are provided"
                }
            }
        }
    },

    "floor": {
        id: "math/floor",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const n = Number(input.value || 0);
            returnCallback({
                output: {
                    result: Math.floor(n)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "floor",
            description: "returns the floor of a number",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "input number",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "floor value"
                }
            }
        }
    },

    "ceil": {
        id: "math/ceil",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const n = Number(input.value || 0);
            returnCallback({
                output: {
                    result: Math.ceil(n)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "ceiling",
            description: "returns the ceiling of a number",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "input number",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "ceiling value"
                }
            }
        }
    },

    "round": {
        id: "math/round",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const n = Number(input.value || 0);
            returnCallback({
                output: {
                    result: Math.round(n)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "round",
            description: "rounds a number to the nearest integer",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "input number",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "rounded value"
                }
            }
        }
    },

    "clamp": {
        id: "math/clamp",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const value = Number(input.value || 0);
            const min = Number(input.min || -Infinity);
            const max = Number(input.max || Infinity);
            returnCallback({
                output: {
                    result: Math.max(min, Math.min(max, value))
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "clamp",
            description: "clamps a value between a minimum and maximum",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "value to clamp",
                    required: true,
                    default: 0
                },
                "min": {
                    type: "number",
                    description: "minimum value",
                    required: false,
                    default: -Infinity
                },
                "max": {
                    type: "number",
                    description: "maximum value",
                    required: false,
                    default: Infinity
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "clamped value"
                }
            }
        }
    },

    "lerp": {
        id: "math/lerp",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.a || 0);
            const b = Number(input.b || 0);
            const t = Number(input.t || 0);
            returnCallback({
                output: {
                    result: a + (b - a) * t
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "linear interpolation",
            description: "interpolates between two values",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "a": {
                    type: "number",
                    description: "start value",
                    required: true,
                    default: 0
                },
                "b": {
                    type: "number",
                    description: "end value",
                    required: true,
                    default: 0
                },
                "t": {
                    type: "number",
                    description: "interpolation factor (0 to 1)",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "interpolated value"
                }
            }
        }
    },

    "distance": {
        id: "math/distance",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const x1 = Number(input.x1 || 0);
            const y1 = Number(input.y1 || 0);
            const x2 = Number(input.x2 || 0);
            const y2 = Number(input.y2 || 0);
            returnCallback({
                output: {
                    result: Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "distance",
            description: "calculates the distance between two points",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "x1": {
                    type: "number",
                    description: "x-coordinate of the first point",
                    required: true,
                    default: 0
                },
                "y1": {
                    type: "number",
                    description: "y-coordinate of the first point",
                    required: true,
                    default: 0
                },
                "x2": {
                    type: "number",
                    description: "x-coordinate of the second point",
                    required: true,
                    default: 0
                },
                "y2": {
                    type: "number",
                    description: "y-coordinate of the second point",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "distance between the two points"
                }
            }
        }
    },

    "mapRange": {
        id: "math/mapRange",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const value = Number(input.value || 0);
            const inMin = Number(input.inMin || 0);
            const inMax = Number(input.inMax || 1);
            const outMin = Number(input.outMin || 0);
            const outMax = Number(input.outMax || 1);
            const result = outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
            returnCallback({
                output: {
                    result
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "map range",
            description: "maps a value from one range to another",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "value to map",
                    required: true,
                    default: 0
                },
                "inMin": {
                    type: "number",
                    description: "input minimum",
                    required: true,
                    default: 0
                },
                "inMax": {
                    type: "number",
                    description: "input maximum",
                    required: true,
                    default: 1
                },
                "outMin": {
                    type: "number",
                    description: "output minimum",
                    required: true,
                    default: 0
                },
                "outMax": {
                    type: "number",
                    description: "output maximum",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "mapped value"
                }
            }
        }
    },

    "power": {
        id: "math/power",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const base = Number(input.base || 1);
            const exponent = Number(input.exponent || 1);
            returnCallback({
                output: {
                    result: Math.pow(base, exponent)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "power",
            description: "calculates the power of a number",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "base": {
                    type: "number",
                    description: "base number",
                    required: true,
                    default: 1
                },
                "exponent": {
                    type: "number",
                    description: "exponent",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "result of the power operation"
                }
            }
        }
    },

    "randomInt": {
        id: "math/randomInt",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const min = Number(input.min || 0);
            const max = Number(input.max || 1);
            returnCallback({
                output: {
                    result: Math.floor(Math.random() * (max - min + 1)) + min
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "random integer",
            description: "returns a random integer between min and max",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "min": {
                    type: "number",
                    description: "minimum value",
                    required: true,
                    default: 0
                },
                "max": {
                    type: "number",
                    description: "maximum value",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "random integer"
                }
            }
        }
    },

    "randomRange": {
        id: "math/randomRange",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const min = Number(input.min || 0);
            const max = Number(input.max || 1);
            returnCallback({
                output: {
                    result: Math.random() * (max - min) + min
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "random range",
            description: "returns a random number between min and max",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "min": {
                    type: "number",
                    description: "minimum value",
                    required: true,
                    default: 0
                },
                "max": {
                    type: "number",
                    description: "maximum value",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "random number"
                }
            }
        }
    },

    "randomVector2": {
        id: "math/randomVector2",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const x = Number(input.x || 0);
            const y = Number(input.y || 0);
            returnCallback({
                output: {
                    vector: { x, y }
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "random vector 2",
            description: "returns a random 2D vector",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "x": {
                    type: "number",
                    description: "x-component",
                    required: true,
                    default: 0
                },
                "y": {
                    type: "number",
                    description: "y-component",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "vector": {
                    type: "object",
                    description: "2D vector"
                }
            }
        }
    },

    "randomVector3": {
        id: "math/randomVector3",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const x = Number(input.x || 0);
            const y = Number(input.y || 0);
            const z = Number(input.z || 0);
            returnCallback({
                output: {
                    vector: { x, y, z }
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "random vector 3",
            description: "returns a random 3D vector",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "x": {
                    type: "number",
                    description: "x-component",
                    required: true,
                    default: 0
                },
                "y": {
                    type: "number",
                    description: "y-component",
                    required: true,
                    default: 0
                },
                "z": {
                    type: "number",
                    description: "z-component",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "vector": {
                    type: "object",
                    description: "3D vector"
                }
            }
        }
    },

    "round": {
        id: "math/round",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const value = Number(input.value || 0);
            const decimals = Number(input.decimals || 0);
            returnCallback({
                output: {
                    result: Number(value.toFixed(decimals))
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "round",
            description: "rounds a number to the specified number of decimals",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "value to round",
                    required: true,
                    default: 0
                },
                "decimals": {
                    type: "number",
                    description: "number of decimals",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "rounded value"
                }
            }
        }
    },

    "sign": {
        id: "math/sign",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const value = Number(input.value || 0);
            returnCallback({
                output: {
                    result: Math.sign(value)
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "sign",
            description: "returns the sign of a number",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "value",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "sign of the value"
                }
            }
        }
    },

    "step": {
        id: "math/step",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const value = Number(input.value || 0);
            const stepSize = Number(input.stepSize || 1);
            returnCallback({
                output: {
                    result: Math.floor(value / stepSize) * stepSize
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "step",
            description: "steps a value by a specified step size",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "value to step",
                    required: true,
                    default: 0
                },
                "stepSize": {
                    type: "number",
                    description: "step size",
                    required: true,
                    default: 1
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "stepped value"
                }
            }
        }
    },

    "subtract": {
        id: "math/subtract",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const a = Number(input.a || 0);
            const b = Number(input.b || 0);
            returnCallback({
                output: {
                    result: a - b
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "subtract",
            description: "subtracts b from a",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "a": {
                    type: "number",
                    description: "first number",
                    required: true,
                    default: 0
                },
                "b": {
                    type: "number",
                    description: "second number",
                    required: true,
                    default: 0
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "result of the subtraction"
                }
            }
        }
    },

    "towards": {
        id: "math/towards",
        artifactType: "process",
        sourceType: "application/javascript",
        source: async (input, state, returnCallback) => {
            const value = Number(input.value || 0);
            const target = Number(input.target || 0);
            const step = Number(input.step || 0.1);
            returnCallback({
                output: {
                    result: value + (target - value) * step
                },
                state
            });
        },
        environment: ["browser", "nodejs"],
        version: "1.0.0",
        metaData: {
            name: "towards",
            description: "moves a value towards a target value",
            tags: ["math", "utility"],
            author: "Nodaic",
            lastUpdated: "2026-08-30",
        },
        interface: {
            inputs: {
                "value": {
                    type: "number",
                    description: "current value",
                    required: true,
                    default: 0
                },
                "target": {
                    type: "number",
                    description: "target value",
                    required: true,
                    default: 0
                },
                "step": {
                    type: "number",
                    description: "step size",
                    required: true,
                    default: 0.1
                }
            },
            outputs: {
                "result": {
                    type: "number",
                    description: "value moved towards the target"
                }
            }
        }
    }
};

module.exports = STATIC_REGISTRY;