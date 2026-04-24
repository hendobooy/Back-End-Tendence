import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';

dotenv.config();

export async function iniciarBanco() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    // Mantendo suas tabelas originais, adaptadas para Postgres
    await pool.query(`
        CREATE TABLE IF NOT EXISTS vagas (
            id SERIAL PRIMARY KEY,
            id_original TEXT,
            fonte TEXT,
            titulo TEXT,
            empresa TEXT,
            data_pub TEXT,
            senioridade TEXT,
            modelo TEXT,
            salario TEXT,
            UNIQUE(id_original, fonte)
        );
        CREATE TABLE IF NOT EXISTS tecnologias (
            id SERIAL PRIMARY KEY,
            nome TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS vagas_techs (
            vaga_id INTEGER,
            tech_id INTEGER,
            tipo TEXT, 
            PRIMARY KEY (vaga_id, tech_id),
            FOREIGN KEY (vaga_id) REFERENCES vagas(id),
            FOREIGN KEY (tech_id) REFERENCES tecnologias(id)
        );
    `);

    return pool;
}

// NOVA FUNÇÃO: Busca métricas de tecnologias
export async function getTechStats(db) {
    const res = await db.query(`
        SELECT t.nome, COUNT(vt.vaga_id) as demanda
        FROM tecnologias t
        JOIN vagas_techs vt ON t.id = vt.tech_id
        GROUP BY t.nome
        ORDER BY demanda DESC
        LIMIT 10
    `);
    return res.rows;
}

export async function getSalariosPorCargo(db, cargo) {
    // Busca vagas que tenham o nome do cargo e possuam algum valor de salário
    const res = await db.query(
        `SELECT salario FROM vagas WHERE titulo ILIKE $1 AND salario != 'Nao_Informado'`,
        [`%${cargo}%`]
    );
    const vagas = res.rows;

    if (vagas.length === 0) {
        return { cargo, media: 0, teto: 0, piso: 0 };
    }

    // Tenta converter o texto "R$ 5.000" em número 5000
    const valores = vagas
        .map(v => {
            // Remove tudo que não é número ou ponto/vírgula
            const limpo = v.salario.replace(/[^\d]/g, '');
            return parseInt(limpo);
        })
        .filter(v => !isNaN(v) && v > 0);

    if (valores.length === 0) {
        return { cargo, media: 0, teto: 0, piso: 0 };
    }

    const soma = valores.reduce((a, b) => a + b, 0);

    return {
        cargo: cargo,
        media: Math.round(soma / valores.length),
        teto: Math.max(...valores),
        piso: Math.min(...valores)
    };
}

export async function salvarVaga(db, vagaPadronizada, vagaIA, fonte) {
    // Tenta salvar a vaga baseada na chave dupla (ID original + Site)
    const res = await db.query(`
        INSERT INTO vagas (id_original, fonte, titulo, empresa, data_pub, senioridade, modelo, salario)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id_original, fonte) DO NOTHING
        RETURNING id
    `, [
        vagaPadronizada.id,
        fonte,
        vagaPadronizada.titulo,
        vagaPadronizada.empresa,
        vagaPadronizada.data_pub,
        vagaIA.senioridade || vagaPadronizada.senioridade,
        vagaIA.modelo || vagaPadronizada.modelo_de_trabalho,
        vagaPadronizada.salario || 'Nao_Informado'
    ]);

    if (res.rowCount === 0) {
        console.error(`⚠️ Vaga já existe no banco (ID: ${vagaPadronizada.id} | Fonte: ${fonte}). Pulando...`);
        return false;
    }

    const idInterno = res.rows[0].id;

    const processarTechs = async (techs, tipo) => {
        if (!techs) return;
        for (const tech of techs) {
            // Insere tecnologia se não existir e retorna o id
            let techRes = await db.query(`
                INSERT INTO tecnologias (nome) VALUES ($1)
                ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
                RETURNING id
            `, [tech]);
            
            const techId = techRes.rows[0].id;

            await db.query(`
                INSERT INTO vagas_techs (vaga_id, tech_id, tipo) VALUES ($1, $2, $3)
                ON CONFLICT (vaga_id, tech_id) DO NOTHING
            `, [idInterno, techId, tipo]);
        }
    };

    await processarTechs(vagaIA.tecnologias_obrigatorias, 'obrigatoria');
    await processarTechs(vagaIA.tecnologias_diferenciais, 'diferencial');

    console.error(`💾 Salvo com sucesso: ${vagaPadronizada.titulo} (${fonte})`);
    return true;
}