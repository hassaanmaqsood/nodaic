/** parseRequest — input: { request: { body?, query?, headers? } } */

export default {
    id: 'parseRequest',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'parseRequest', description: 'input: { request: { body?, query?, headers? } }', tags: ['core'] },
    source: `
        function _validate(data, schema) {
            const result = { ...data };
            const errors = [];
            for (const [field, rules] of Object.entries(schema)) {
                if (rules.required && !(field in data)) {
                    errors.push(\`\${field} is required\`);
                    if (rules.default !== undefined) result[field] = rules.default;
                }
                if (field in data && rules.type && typeof data[field] !== rules.type) {
                    errors.push(\`\${field} must be \${rules.type}\`);
                }
                if (field in data && rules.enum && !rules.enum.includes(data[field])) {
                    errors.push(\`\${field} must be one of: \${rules.enum.join(', ')}\`);
                }
                if (!(field in data) && rules.default !== undefined) result[field] = rules.default;
            }
            return { result, errors, ok: errors.length === 0 };
        }

        const req = input.request ?? input ?? {};
        const bodySchema = input.bodySchema ?? state.bodySchema;
        const querySchema = input.querySchema ?? state.querySchema;
        const headerSchema = input.headerSchema ?? state.headerSchema;

        const body = bodySchema ? _validate(req.body ?? {}, bodySchema) : { result: req.body ?? {}, errors: [] };
        const query = querySchema ? _validate(req.query ?? {}, querySchema) : { result: req.query ?? {}, errors: [] };
        const hdrs = headerSchema ? _validate(req.headers ?? {}, headerSchema) : { result: req.headers ?? {}, errors: [] };
        const errors = [...body.errors, ...query.errors, ...hdrs.errors];

        returnCallback({ output: { body: body.result, query: query.result, headers: hdrs.result, errors, ok: errors.length === 0 }, state });
    `,
    interface: {
        inputs: { 
            request: { type: 'object' }, 
            bodySchema: { type: 'object' }, 
            querySchema: { type: 'object' }, 
            headerSchema: { type: 'object' } 
        },
        outputs: { 
            body: { type: 'object' }, 
            query: { type: 'object' }, 
            headers: { type: 'object' }, 
            errors: { type: 'array' }, 
            ok: { type: 'boolean' } 
        }
    }
};
