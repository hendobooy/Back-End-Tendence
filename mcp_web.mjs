import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
const { Pool } = pg;
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function getDb() {
    return pool;
}

const server = new Server(
    { name: "tech-tendence-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "listar_techs_em_alta",
                description: "Retorna as 10 tecnologias mais exigidas baseadas em um cargo.",
                inputSchema: {
                    type: "object",
                    properties: {
                        palavras_chave: {
                            type: "array",
                            items: { type: "string" },
                            description: "Ex: ['Dados', 'Data'], ['Front', 'React'], ['Sec', 'Segurança']"
                        }
                    },
                    required: ["palavras_chave"]
                }
            },
            {
                name: "panorama_salarial",
                description: "Busca os salários reais oferecidos para um determinado cargo.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cargo: { type: "string", description: "Ex: Engenheiro de Software" }
                    },
                    required: ["cargo"]
                }
            },
            {
                name: "buscar_vagas_por_hardskill",
                description: "Encontra vagas abertas que exigem uma tecnologia específica.",
                inputSchema: {
                    type: "object",
                    properties: {
                        hardskill: { type: "string", description: "Ex: Python, React, SQL" }
                    },
                    required: ["hardskill"]
                }
            },
            {
                name: "buscar_cursos_recomendados",
                description: "Busca cursos na base de dados filtrando por tecnologia e nível necessário (Básico, Intermediário, Avançado).",
                inputSchema: {
                    type: "object",
                    properties: {
                        tecnologia: { type: "string", description: "Nome da tecnologia (ex: Python, AWS, React)" },
                        nivel_curso: { type: "string", enum: ["Básico", "Intermediário", "Avançado"] }
                    },
                    required: ["tecnologia", "nivel_curso"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const db = await getDb();
    const args = request.params.arguments;

    try {
        if (request.params.name === "listar_techs_em_alta") {
            const palavras = args.palavras_chave;
            if (!palavras || !Array.isArray(palavras) || palavras.length === 0) {
                return { content: [{ type: "text", text: "Erro: Forneça um array 'palavras_chave' válido (ex: ['Python', 'Dados'])." }] };
            }

            const condicoes = palavras.map((_, i) => `v.titulo ILIKE $${i + 1}`).join(' OR ');
            const parametros = palavras.map(p => `%${p}%`);

            // Conta vagas únicas
            const countQuery = `SELECT COUNT(DISTINCT v.id) as total FROM vagas v WHERE ${condicoes}`;
            const countRes = await db.query(countQuery, parametros);
            const totalVagas = countRes.rows[0].total;

            // Busca tecnologias dessas vagas sem duplicar a contagem
            const techsQuery = `
                SELECT t.nome as tecnologia, COUNT(DISTINCT v.id) as demandas
                FROM tecnologias t
                JOIN vagas_techs vt ON t.id = vt.tech_id
                JOIN vagas v ON v.id = vt.vaga_id
                WHERE ${condicoes}
                GROUP BY t.id, t.nome
                ORDER BY demandas DESC
                LIMIT 10
            `;
            const techsRes = await db.query(techsQuery, parametros);

            const resultado = {
                total_vagas_analisadas: totalVagas,
                tecnologias: techsRes.rows
            };

            return { content: [{ type: "text", text: JSON.stringify(resultado, null, 2) }] };
        }

        if (request.params.name === "panorama_salarial") {
            const query = `
                SELECT empresa, titulo, senioridade, salario 
                FROM vagas 
                WHERE titulo ILIKE $1 AND salario NOT IN ('A combinar', 'Nao_Informado', '')
                LIMIT 30
            `;
            const res = await db.query(query, [`%${args.cargo}%`]);
            return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
        }

        if (request.params.name === "buscar_vagas_por_hardskill") {
            const query = `
                SELECT v.titulo, v.empresa, v.modelo, v.salario, v.fonte 
                FROM vagas v 
                JOIN vagas_techs vt ON v.id = vt.vaga_id 
                JOIN tecnologias t ON t.id = vt.tech_id 
                WHERE t.nome ILIKE $1 
                LIMIT 15
            `;
            const res = await db.query(query, [`%${args.hardskill}%`]);
            return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
        }

        if (request.params.name === "buscar_cursos_recomendados") {
            const { tecnologia, nivel_curso } = args;

            let query = `
                SELECT nome_curso, link, tipo_curso, carga_horaria 
                FROM cursos 
                WHERE tecnologia ILIKE $1 AND nivel_curso = $2 
                LIMIT 5
            `;

            let res = await db.query(query, [`%${tecnologia}%`, nivel_curso]);
            let rows = res.rows;

            // FALLBACK: Se não achar cursos para o nível exigido (ex: Avançado), tenta buscar qualquer curso daquela tecnologia
            if (rows.length === 0) {
                const fallbackQuery = `
                    SELECT nome_curso, link, tipo_curso, carga_horaria 
                    FROM cursos 
                    WHERE tecnologia ILIKE $1 
                    LIMIT 5
                `;
                const fallbackRes = await db.query(fallbackQuery, [`%${tecnologia}%`]);
                rows = fallbackRes.rows;
            }

            const responseText = rows.length > 0 ? JSON.stringify(rows, null, 2) : "Nenhum curso encontrado para este filtro.";

            return { content: [{ type: "text", text: responseText }] };
        }

        throw new Error("Ferramenta desconhecida");
    } catch (error) {
        console.error("Erro ao executar ferramenta:", error);
        return { content: [{ type: "text", text: `Erro interno: ${error.message}` }], isError: true };
    }
    // No Postgres Pool, não fechamos a conexão a cada chamada, mas poderíamos soltar um client se estivéssemos usando client.connect()
});

// Inicialização com Stdio (Padrão para Claude Desktop)
async function startServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Usamos console.error para não poluir o stdout!
    console.error("🚀 Servidor MCP conectado via stdio!");
}

startServer().catch((error) => {
    console.error("Erro fatal no servidor MCP:", error);
    process.exit(1);
});