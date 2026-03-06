const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    ActionRowBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

// ─── PATHS ─────────────────────────────────────────────────────────
const FORMS_PATH = path.join(__dirname, 'forms.json');

// ─── HELPERS ───────────────────────────────────────────────────────
function loadForms() {
    return JSON.parse(fs.readFileSync(FORMS_PATH, 'utf-8'));
}

function saveForms(data) {
    fs.writeFileSync(FORMS_PATH, JSON.stringify(data, null, 2));
}

// Track active application sessions: threadId -> { formId, userId, answers, questionIndex }
const activeSessions = new Map();

// ─── DISCORD BOT ───────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}`);

    // Register /apply command
    const command = new SlashCommandBuilder()
        .setName('apply')
        .setDescription('Submit an application');

    await client.application.commands.create(command);
    console.log('Registered /apply command');
});

// ─── SEND NEXT QUESTION IN THREAD ─────────────────────────────────
async function sendQuestion(thread, sess) {
    const data = loadForms();
    const form = data.forms.find(f => f.id === sess.formId);
    if (!form) return;

    const q = form.questions[sess.questionIndex];
    if (!q) return;

    const progress = `**Question ${sess.questionIndex + 1}/${form.questions.length}**`;
    const requiredTag = q.required ? ' *(required)*' : ' *(optional — type `skip` to skip)*';

    if (q.type === 'choice' && q.options && q.options.length > 0) {
        // Send a select menu for choice questions
        const select = new StringSelectMenuBuilder()
            .setCustomId(`answer_choice_${sess.formId}_${q.id}`)
            .setPlaceholder('Select an option...')
            .addOptions(q.options.map(opt => ({ label: opt, value: opt })));

        const row = new ActionRowBuilder().addComponents(select);

        await thread.send({
            content: `${progress}\n${q.label}${requiredTag}`,
            components: [row]
        });
    } else {
        // Text or paragraph — user types their answer
        const typeHint = q.type === 'paragraph' ? '\n*Write a detailed response below:*' : '';
        await thread.send(`${progress}\n${q.label}${requiredTag}${typeHint}`);
    }
}

// ─── PROCESS ANSWER & ADVANCE ──────────────────────────────────────
async function processAnswer(thread, sess, answer) {
    const data = loadForms();
    const form = data.forms.find(f => f.id === sess.formId);
    if (!form) return;

    const q = form.questions[sess.questionIndex];

    // Handle skip for optional questions
    if (answer.toLowerCase() === 'skip' && !q.required) {
        sess.answers.push({ question: q.label, answer: '*Skipped*' });
    } else if (answer.toLowerCase() === 'skip' && q.required) {
        await thread.send('This question is **required**. Please provide an answer.');
        return;
    } else {
        sess.answers.push({ question: q.label, answer });
    }

    sess.questionIndex++;

    // Check if form is complete
    if (sess.questionIndex >= form.questions.length) {
        await submitApplication(thread, sess, form);
    } else {
        await sendQuestion(thread, sess);
    }
}

// ─── SUBMIT COMPLETED APPLICATION ──────────────────────────────────
async function submitApplication(thread, sess, form) {
    activeSessions.delete(thread.id);

    await thread.send({
        embeds: [new EmbedBuilder()
            .setColor(0x57F287)
            .setDescription('Your application has been submitted! You will be notified of the result.')
        ]
    });

    // Lock the thread
    try { await thread.setLocked(true); } catch {}

    // Build review embeds (split across multiple if needed, Discord has 25 field limit)
    const reviewChannelId = process.env[form.reviewChannelEnvKey] || process.env.REVIEW_CHANNEL_ID;
    const reviewChannel = client.channels.cache.get(reviewChannelId);

    if (!reviewChannel) {
        console.error(`Review channel not found for form ${form.id}`);
        return;
    }

    const user = await client.users.fetch(sess.userId);
    const embeds = [];
    let currentEmbed = new EmbedBuilder()
        .setTitle(`New ${form.title}`)
        .setColor(0x5865F2)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'Applicant', value: `${user} (${user.tag})`, inline: true },
            { name: 'User ID', value: user.id, inline: true },
            { name: '\u200b', value: '\u200b' }
        )
        .setTimestamp();

    let fieldCount = 3;

    for (const a of sess.answers) {
        // Truncate long answers for embed field limit (1024 chars)
        const val = a.answer.length > 1024 ? a.answer.substring(0, 1021) + '...' : a.answer;
        // Truncate label for field name limit (256 chars)
        const name = a.question.length > 256 ? a.question.substring(0, 253) + '...' : a.question;

        if (fieldCount >= 24) {
            // Start a new embed
            embeds.push(currentEmbed);
            currentEmbed = new EmbedBuilder().setColor(0x5865F2);
            fieldCount = 0;
        }

        currentEmbed.addFields({ name, value: val || 'N/A' });
        fieldCount++;
    }

    embeds.push(currentEmbed);

    // Approve / Deny buttons
    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`approve_${sess.userId}`)
            .setLabel('Approve')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`deny_${sess.userId}`)
            .setLabel('Deny')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
    );

    await reviewChannel.send({ embeds, components: [buttons] });
}

// ─── INTERACTION HANDLER ───────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    try {
        // ─── /apply COMMAND ────────────────────────────
        if (interaction.isChatInputCommand() && interaction.commandName === 'apply') {
            const data = loadForms();

            if (!data.forms || data.forms.length === 0) {
                return await interaction.reply({
                    content: 'No application forms are available right now.',
                    ephemeral: true
                });
            }

            // Show form selection menu
            const select = new StringSelectMenuBuilder()
                .setCustomId('select_form')
                .setPlaceholder('Choose an application...')
                .addOptions(data.forms.map(f => ({
                    label: f.title,
                    description: (f.description || '').substring(0, 100),
                    value: f.id
                })));

            const row = new ActionRowBuilder().addComponents(select);

            return await interaction.reply({
                content: 'Which application would you like to fill out?',
                components: [row],
                ephemeral: true
            });
        }

        // ─── FORM SELECTION ────────────────────────────
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_form') {
            const formId = interaction.values[0];
            const data = loadForms();
            const form = data.forms.find(f => f.id === formId);

            if (!form) {
                return await interaction.update({ content: 'Form not found.', components: [] });
            }

            // Check if user already has an active session
            for (const [, s] of activeSessions) {
                if (s.userId === interaction.user.id) {
                    return await interaction.update({
                        content: 'You already have an application in progress. Please finish or wait for it to expire.',
                        components: []
                    });
                }
            }

            await interaction.update({
                content: 'Creating your application thread...',
                components: []
            });

            // Fetch the full channel from the guild
            const guild = await client.guilds.fetch(interaction.guildId);
            const channel = await guild.channels.fetch(interaction.channelId);

            // Create a private thread for the application
            const thread = await channel.threads.create({
                name: `${form.title} - ${interaction.user.username}`,
                type: ChannelType.PrivateThread,
                reason: `Application by ${interaction.user.tag}`
            });

            // Add the user to the thread
            await thread.members.add(interaction.user.id);

            // Start session
            const sess = {
                formId,
                userId: interaction.user.id,
                answers: [],
                questionIndex: 0,
                startedAt: Date.now()
            };
            activeSessions.set(thread.id, sess);

            // Send intro message
            const intro = new EmbedBuilder()
                .setTitle(form.title)
                .setColor(0x5865F2)
                .setDescription(
                    (form.description ? form.description + '\n\n' : '') +
                    `This form has **${form.questions.length} questions**.\n` +
                    'Answer each question by typing your response in this thread.\n' +
                    'Type `cancel` at any time to cancel your application.'
                );

            await thread.send({ embeds: [intro] });

            // Send first question
            await sendQuestion(thread, sess);
        }

        // ─── CHOICE ANSWER (SELECT MENU) ──────────────
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('answer_choice_')) {
            const sess = activeSessions.get(interaction.channel.id);
            if (!sess || sess.userId !== interaction.user.id) {
                return await interaction.reply({ content: 'This is not your application.', ephemeral: true });
            }

            const answer = interaction.values[0];
            await interaction.update({ content: `${interaction.message.content}\n> **${answer}**`, components: [] });
            await processAnswer(interaction.channel, sess, answer);
        }

        // ─── APPROVE / DENY BUTTONS ───────────────────
        if (interaction.isButton()) {
            const [action, userId] = interaction.customId.split('_');

            if (action !== 'approve' && action !== 'deny') return;

            if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return await interaction.reply({
                    content: 'You do not have permission to review applications.',
                    ephemeral: true
                });
            }

            if (action === 'deny') {
                // Show modal asking for denial reason
                const modal = new ModalBuilder()
                    .setCustomId(`deny_reason_${userId}_${interaction.message.id}`)
                    .setTitle('Deny Application');

                const reasonInput = new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Reason for denial')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Provide a reason that will be sent to the applicant...')
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                return await interaction.showModal(modal);
            }

            // Approve — no reason needed
            const statusColor = 0x57F287;

            const originalEmbed = interaction.message.embeds[0];
            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setColor(statusColor)
                .setFooter({ text: `APPROVED by ${interaction.user.tag}` });

            const otherEmbeds = interaction.message.embeds.slice(1).map(e =>
                EmbedBuilder.from(e).setColor(statusColor)
            );

            try {
                const applicant = await client.users.fetch(userId);
                const dmEmbed = new EmbedBuilder()
                    .setTitle('Application APPROVED')
                    .setColor(statusColor)
                    .setDescription('Congratulations! Your application has been approved.')
                    .setTimestamp();

                await applicant.send({ embeds: [dmEmbed] });
            } catch {}

            await interaction.update({
                embeds: [updatedEmbed, ...otherEmbeds],
                components: []
            });
        }

        // ─── DENY REASON MODAL SUBMIT ────────────────────
        if (interaction.isModalSubmit() && interaction.customId.startsWith('deny_reason_')) {
            const parts = interaction.customId.split('_');
            // deny_reason_USERID_MESSAGEID
            const userId = parts[2];
            const messageId = parts[3];
            const reason = interaction.fields.getTextInputValue('reason');

            const statusColor = 0xED4245;

            // Update the original review message
            const reviewMessage = await interaction.channel.messages.fetch(messageId);

            const originalEmbed = reviewMessage.embeds[0];
            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setColor(statusColor)
                .setFooter({ text: `DENIED by ${interaction.user.tag}` })
                .addFields({ name: 'Denial Reason', value: reason });

            const otherEmbeds = reviewMessage.embeds.slice(1).map(e =>
                EmbedBuilder.from(e).setColor(statusColor)
            );

            await reviewMessage.edit({
                embeds: [updatedEmbed, ...otherEmbeds],
                components: []
            });

            // DM the applicant with the reason
            try {
                const applicant = await client.users.fetch(userId);
                const dmEmbed = new EmbedBuilder()
                    .setTitle('Application DENIED')
                    .setColor(statusColor)
                    .setDescription('Unfortunately, your application has been denied.')
                    .addFields({ name: 'Reason', value: reason })
                    .setTimestamp();

                await applicant.send({ embeds: [dmEmbed] });
            } catch {}

            await interaction.reply({ content: 'Application denied and applicant notified.', ephemeral: true });
        }
    } catch (err) {
        console.error('Interaction error:', err);
    }
});

// ─── MESSAGE HANDLER (for thread answers) ──────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const sess = activeSessions.get(message.channel.id);
    if (!sess) return;
    if (message.author.id !== sess.userId) return;

    // Cancel command
    if (message.content.toLowerCase() === 'cancel') {
        activeSessions.delete(message.channel.id);
        await message.reply('Application cancelled.');
        try { await message.channel.setLocked(true); } catch {}
        try { await message.channel.setArchived(true); } catch {}
        return;
    }

    // Check if current question is a choice type (handled by select menu, not text)
    const data = loadForms();
    const form = data.forms.find(f => f.id === sess.formId);
    if (!form) return;

    const currentQ = form.questions[sess.questionIndex];
    if (currentQ && currentQ.type === 'choice') {
        await message.reply('Please use the dropdown menu above to select your answer.');
        return;
    }

    // Process text answer
    await processAnswer(message.channel, sess, message.content);
});

// ─── AUTO-EXPIRE SESSIONS (30 min timeout) ─────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [threadId, sess] of activeSessions) {
        if (now - sess.startedAt > 30 * 60 * 1000) {
            activeSessions.delete(threadId);
            const thread = client.channels.cache.get(threadId);
            if (thread) {
                thread.send('This application has timed out (30 minutes). Please use `/apply` to start a new one.')
                    .then(() => thread.setLocked(true).catch(() => {}))
                    .catch(() => {});
            }
        }
    }
}, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// EXPRESS WEB SERVER + DASHBOARD
// ═══════════════════════════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function getBaseUrl(req) {
    if (process.env.BASE_URL) return process.env.BASE_URL;
    return `${req.protocol}://${req.get('host')}`;
}

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

// ─── DISCORD OAUTH2 ───────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
    const redirectUri = encodeURIComponent(`${getBaseUrl(req)}/auth/callback`);
    const clientId = process.env.APPLICATION_ID || '1479267438469320856';
    const scope = encodeURIComponent('identify guilds');
    const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        const clientId = process.env.APPLICATION_ID || '1479267438469320856';
        const clientSecret = process.env.CLIENT_SECRET;
        const redirectUri = `${getBaseUrl(req)}/auth/callback`;

        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri
            })
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.error('OAuth token error:', tokenData);
            return res.redirect('/?error=token_failed');
        }

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();

        const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const guilds = await guildsRes.json();

        const guildId = process.env.GUILD_ID;
        const guild = guilds.find(g => g.id === guildId);

        if (!guild) return res.redirect('/?error=not_in_guild');

        const hasPermission = guild.owner || (BigInt(guild.permissions) & BigInt(0x20)) !== BigInt(0);
        if (!hasPermission) return res.redirect('/?error=no_permission');

        req.session.user = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            avatar: user.avatar,
            globalName: user.global_name
        };

        res.redirect('/');
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.redirect('/?error=auth_failed');
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/auth/me', (req, res) => {
    if (req.session && req.session.user) return res.json(req.session.user);
    res.status(401).json({ error: 'Not authenticated' });
});

// ─── API ROUTES ────────────────────────────────────────────────────
app.get('/api/forms', requireAuth, (req, res) => {
    const data = loadForms();
    res.json(data);
});

app.post('/api/forms', requireAuth, (req, res) => {
    const { forms } = req.body;

    if (!forms || !Array.isArray(forms)) {
        return res.status(400).json({ error: 'Invalid forms array' });
    }

    for (const form of forms) {
        if (!form.id || !form.title) {
            return res.status(400).json({ error: 'Each form needs an id and title' });
        }
        if (!form.questions || !Array.isArray(form.questions)) {
            return res.status(400).json({ error: `Form "${form.title}" has invalid questions` });
        }
        for (const q of form.questions) {
            if (!q.id || !q.label) {
                return res.status(400).json({ error: `Questions in "${form.title}" need an id and label` });
            }
        }
    }

    saveForms({ forms });
    res.json({ success: true });
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: client.isReady() ? 'online' : 'offline' });
});

// ─── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

client.login(process.env.BOT_TOKEN).then(() => {
    app.listen(PORT, () => {
        console.log(`Dashboard running on port ${PORT}`);
    });
});
