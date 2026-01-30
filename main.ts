import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl } from 'obsidian';
import { GAOKAO_WORDS } from './gaokao_vocabulary';

/**
 * 核心配置接口
 */
interface EnglishLearningSettings {
    vocabularyBookPath: string;
    autoRead: boolean;
    exclusionList: string;
}

const DEFAULT_SETTINGS: EnglishLearningSettings = {
    vocabularyBookPath: 'Vocabulary.md',
    autoRead: true,
    exclusionList: ''
}

/**
 * 有道词典 API 响应结果接口 (精简版)
 */
interface YoudaoData {
    word: string;
    phonetic?: string;
    translations: { pos: string; means: string[] }[];
    example?: { en: string; zh: string };
    audioUrl?: string;
}

/**
 * 单词条目接口
 */
interface WordEntry {
    word: string;
    phonetic: string;
    translation: string;
    exampleEn: string;
    exampleZh: string;
    audio: string;
}

export default class EnglishLearningPlugin extends Plugin {
    settings: EnglishLearningSettings;
    popup: HTMLElement | null = null;
    customExclusion: Set<string> = new Set();

    async onload() {
        await this.loadSettings();
        this.parseExclusionList();

        // 注册 Markdown 处理器，用于自动高亮生词
        this.registerMarkdownPostProcessor((element) => {
            this.highlightWords(element);
        });

        // 注册全局鼠标事件
        this.registerDomEvent(document, 'mouseup', (evt: MouseEvent) => {
            this.handleSelection(evt);
        });

        // 注册点击卡片外部关闭卡片
        this.registerDomEvent(document, 'mousedown', (evt: MouseEvent) => {
            if (this.popup && !this.popup.contains(evt.target as Node)) {
                this.closePopup();
            }
        });

        this.addSettingTab(new EnglishLearningSettingTab(this.app, this));
        console.log('English Learning Plugin Loaded (Premium Version)');
    }

    onunload() {
        this.closePopup();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.parseExclusionList();
    }

    parseExclusionList() {
        this.customExclusion = new Set(
            this.settings.exclusionList.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0)
        );
    }

    private closePopup() {
        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }
    }

    /**
     * 高亮生词逻辑 - 交互革命版 (全词可点击)
     */
    highlightWords(element: HTMLElement) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
        let node: Node | null;
        const nodesToReplace: { node: Text, fragment: DocumentFragment }[] = [];

        while (node = walker.nextNode()) {
            const parent = node.parentElement;
            // 跳过代码块、链接、以及已经处理过的区域
            if (parent && (parent.tagName === 'CODE' || parent.tagName === 'PRE' || parent.tagName === 'A' ||
                parent.classList.contains('dict-word-clickable') || parent.closest('.dict-card'))) {
                continue;
            }

            const text = node.textContent;
            if (!text || text.length < 2) continue;

            // 匹配所有长度 2 以上的英文单词
            const parts = text.split(/(\b[a-zA-Z]{2,}\b)/g);
            if (parts.length <= 1) continue;

            const fragment = document.createDocumentFragment();
            let hasProcessed = false;

            parts.forEach(part => {
                if (/^[a-zA-Z]{2,}$/.test(part)) {
                    const lower = part.toLowerCase();
                    const span = document.createElement('span');
                    span.textContent = part;
                    span.addClass('dict-word-clickable');
                    span.setAttribute('title', '点击查看有道释义');

                    // 核心过滤逻辑：判断是否是生词
                    const isCommon = GAOKAO_WORDS.has(lower) ||
                        this.customExclusion.has(lower) ||
                        (lower.endsWith('s') && GAOKAO_WORDS.has(lower.slice(0, -1))) ||
                        (lower.endsWith('es') && GAOKAO_WORDS.has(lower.slice(0, -2))) ||
                        (lower.endsWith('ed') && GAOKAO_WORDS.has(lower.slice(0, -2))) ||
                        (lower.endsWith('ed') && GAOKAO_WORDS.has(lower.slice(0, -1))) ||
                        (lower.endsWith('ing') && GAOKAO_WORDS.has(lower.slice(0, -3))) ||
                        (lower.endsWith('ing') && GAOKAO_WORDS.has(lower.slice(0, -3) + 'e'));

                    if (!isCommon) {
                        span.addClass('word-highlight'); // 仅生词高亮颜色
                    }

                    // 注入点击即查词逻辑
                    span.onclick = (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const rect = span.getBoundingClientRect();
                        this.showPopup(lower, rect.left + window.scrollX, rect.bottom + window.scrollY);
                    };

                    fragment.appendChild(span);
                    hasProcessed = true;
                } else {
                    fragment.appendChild(document.createTextNode(part));
                }
            });

            if (hasProcessed) {
                nodesToReplace.push({ node: node as Text, fragment });
            }
        }

        nodesToReplace.forEach(({ node, fragment }) => {
            try {
                if (node.parentNode) {
                    node.parentNode.replaceChild(fragment, node);
                }
            } catch (e) { }
        });
    }

    /**
     * 处理选词查询
     */
    async handleSelection(evt: MouseEvent) {
        // 如果点击的是卡片内部，则直接忽略（防止闪烁）
        if (this.popup && this.popup.contains(evt.target as Node)) return;

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;

        const text = selection.toString().trim();
        // 过滤非纯英文或太长/太短的词
        if (!text || !/^[a-zA-Z]+$/.test(text) || text.length < 2 || text.length > 40) return;

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        // 自动朗读
        if (this.settings.autoRead) {
            this.speak(text);
        }

        await this.showPopup(text, rect.left + window.scrollX, rect.bottom + window.scrollY);
    }

    private speak(word: string) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(word);
        utterance.lang = 'en-US';
        utterance.rate = 1.0;
        window.speechSynthesis.speak(utterance);
    }

    /**
     * 核心 API 调用：有道移动端接口
     */
    async fetchYoudao(word: string): Promise<WordEntry | null> {
        try {
            // 使用 requestUrl 绕过 CORS
            const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}&client=mobile&dicts=%7B%22count%22%3A99%2C%22dicts%22%3A%5B%5B%22ec%22%2C%22blng_sents%22%5D%5D%7D`;
            const response = await requestUrl({ url });

            if (response.status !== 200) return null;
            const data = response.json;

            // 解析所有可能的数据源
            let phonetic = "";
            let translations: string[] = [];
            let exampleEn = "";
            let exampleZh = "";

            // 1. 尝试从 simple 读取基础音标
            if (data.simple && data.simple.word && data.simple.word[0]) {
                const s = data.simple.word[0];
                phonetic = s.usphone ? `/${s.usphone}/` : (s.ukphone ? `/${s.ukphone}/` : "");
            }

            // 2. 解析 EC (English-Chinese) 词典
            if (data.ec && data.ec.word && data.ec.word[0]) {
                const ec = data.ec.word[0];
                if (!phonetic) {
                    phonetic = ec.phonetic ? `/${ec.phonetic}/` : (ec.ukphone ? `/${ec.ukphone}/` : "");
                }

                // 提取释义 (有多层嵌套 tr -> l -> i)
                if (ec.trs && ec.trs.length > 0) {
                    ec.trs.forEach((t: any) => {
                        if (t.tr && t.tr[0] && t.tr[0].l && t.tr[0].l.i) {
                            translations.push(t.tr[0].l.i[0]);
                        }
                    });
                }
            }

            // 3. 提取例句
            if (data.blng_sents_part && data.blng_sents_part['sentence-pair']) {
                const pair = data.blng_sents_part['sentence-pair'][0];
                if (pair.sentence && pair['sentence-translation']) {
                    exampleEn = pair.sentence.replace(/<\/?[^>]+(>|$)/g, ""); // 移除 HTML 标签
                    exampleZh = pair['sentence-translation'];
                }
            }

            if (translations.length === 0) return null;

            const audio = `https://dict.youdao.com/dictvoice?audio=${word}&type=2`;

            return {
                word: word,
                phonetic: phonetic,
                translation: translations.join('\n'),
                exampleEn: exampleEn,
                exampleZh: exampleZh,
                audio: audio
            };
        } catch (error) {
            console.error('Youdao API error:', error);
            return null;
        }
    }

    /**
     * 弹出卡片管理
     */
    async showPopup(word: string, x: number, y: number) {
        this.closePopup();

        this.popup = document.body.createDiv('dict-card');
        this.popup.style.left = `${x}px`;
        this.popup.style.top = `${y + 10}px`;

        // 加载中状态
        const loader = this.popup.createDiv('dict-loading-wrap');
        loader.createDiv('dict-spinner');
        loader.createEl('span', { text: '正在调取有道官方释义...' });

        const data = await this.fetchYoudao(word.toLowerCase());

        if (!data) {
            this.popup.innerHTML = '<div class="dict-loading-wrap"><span>未找到该单词的权威释义</span></div>';
            setTimeout(() => this.closePopup(), 1500);
            return;
        }

        this.renderCard(data);
    }

    /**
     * 渲染卡片 DOM
     */
    private renderCard(data: WordEntry) {
        if (!this.popup) return;
        this.popup.empty();

        const container = this.popup.createDiv('dict-container');

        // Header
        const header = container.createDiv('dict-header');
        const wordGroup = header.createDiv('dict-word-group');
        wordGroup.createEl('h1', { text: data.word, cls: 'dict-word' });
        if (data.phonetic) {
            wordGroup.createEl('div', { text: data.phonetic, cls: 'dict-phonetic' });
        }

        const topActions = header.createDiv('dict-actions-top');

        // 发音按钮 (SVG)
        const audioBtn = topActions.createEl('button', { cls: 'dict-audio-btn' });
        audioBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
        audioBtn.onclick = () => {
            const audio = new Audio(data.audio);
            audio.play();
        };

        // 释义区
        const meanings = container.createDiv('dict-meanings');
        const lines = data.translation.split('\n');
        lines.forEach(line => {
            const row = meanings.createDiv('dict-meaning-item');
            const match = line.match(/^([a-z]+\.)\s*(.*)$/i);
            if (match) {
                row.createEl('span', { text: match[1], cls: 'dict-pos' });
                row.createEl('span', { text: match[2], cls: 'dict-meaning-text' });
            } else {
                row.createEl('span', { text: line, cls: 'dict-meaning-text' });
            }
        });

        // 例句区
        if (data.exampleEn) {
            const exampleSec = container.createDiv('dict-example-section');
            exampleSec.createDiv({ text: 'BILINGUAL EXAMPLE', cls: 'dict-example-label' });
            exampleSec.createDiv({ text: data.exampleEn, cls: 'dict-example-en' });
            if (data.exampleZh) {
                exampleSec.createDiv({ text: data.exampleZh, cls: 'dict-example-zh' });
            }
        }

        // Footer
        const footer = container.createDiv('dict-footer');
        const addBtn = footer.createEl('button', { text: '加入生词本', cls: 'dict-btn-primary' });
        addBtn.onclick = () => {
            this.addToVocabulary(data);
            this.closePopup();
        };

        const closeBtn = footer.createEl('button', { text: '关闭', cls: 'dict-btn-outline' });
        closeBtn.onclick = () => this.closePopup();

        // 调整位置确保不超出屏幕
        const cardRect = this.popup.getBoundingClientRect();
        if (cardRect.right > window.innerWidth) {
            this.popup.style.left = `${window.innerWidth - cardRect.width - 20}px`;
        }
        if (cardRect.bottom > window.innerHeight) {
            this.popup.style.top = `${cardRect.top - cardRect.height - 40}px`;
        }
    }

    /**
     * 添加到生词本 (Markdown 格式)
     */
    async addToVocabulary(data: WordEntry) {
        const path = this.settings.vocabularyBookPath;
        let file = this.app.vault.getAbstractFileByPath(path);

        const timestamp = new Date().toLocaleString();
        const tr = data.translation.replace(/\n/g, ' ');
        const row = `\n| ${data.word} | ${data.phonetic} | ${tr} | ${timestamp} |`;
        const header = `| 单词 | 音标 | 释义 | 时间 |\n| --- | --- | --- | --- |`;

        try {
            if (!file) {
                await this.app.vault.create(path, header + row);
            } else {
                const content = await this.app.vault.read(file as any);
                if (!content.includes('| 单词 |')) {
                    await this.app.vault.modify(file as any, header + content + row);
                } else {
                    await this.app.vault.append(file as any, row);
                }
            }
            new Notice(`已存入生词本: ${data.word}`);
        } catch (err) {
            new Notice('保存失败，请检查文件路径设置');
            console.error(err);
        }
    }
}

/**
 * 设置面板
 */
class EnglishLearningSettingTab extends PluginSettingTab {
    plugin: EnglishLearningPlugin;
    constructor(app: App, plugin: EnglishLearningPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'English Learning Settings' });

        new Setting(containerEl)
            .setName('Vocabulary Book Path')
            .setDesc('Path to your vocabulary markdown file (e.g., Folder/Vocabulary.md)')
            .addText(text => text
                .setValue(this.plugin.settings.vocabularyBookPath)
                .onChange(async (value) => {
                    this.plugin.settings.vocabularyBookPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto Spoken')
            .setDesc('Automatically read word on selection')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoRead)
                .onChange(async (value) => {
                    this.plugin.settings.autoRead = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Exclusion List')
            .setDesc('Comma separated words to ignore (e.g. apple, banana)')
            .addTextArea(text => text
                .setValue(this.plugin.settings.exclusionList)
                .onChange(async (value) => {
                    this.plugin.settings.exclusionList = value;
                    await this.plugin.saveSettings();
                }));
    }
}
