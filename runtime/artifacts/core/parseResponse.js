/** parseResponse — input: { data: object, schema?, status?, meta? } */

export default {
    id: 'parseResponse',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'parseResponse', description: 'input: { data, schema?, status?, meta? }', tags: ['core'] },
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

        const data = input.data ?? input;
        const schema = input.schema ?? state.schema;
        const status = input.status ?? state.status ?? 200;
        const meta = input.meta ?? state.meta;

        if (schema) {
            const { result, errors, ok } = _validate(data, schema);
            returnCallback({
                output: {
                    status: ok ? status : 422,
                    body: ok ? { data: result, ...(meta ? { meta } : {}) } : { errors },
                    ok, errors
                },
                state
            });
        } else {
            returnCallback({
                output: {
                    status,
                    body: { data, ...(meta ? { meta } : {}) },
                    ok: true, errors: []
                },
                state
            });
        }
    `,
    interface: {
        inputs: { 
            data: { type: 'any' }, 
            schema: { type: 'object' }, 
            status: { type: 'number' }, 
            meta: { type: 'object' } 
        },
        outputs: { 
            status: { type: 'number' }, 
            body: { type: 'object' }, 
            ok: { type: 'boolean' }, 
            errors: { type: 'array' } 
        }
    }
};
