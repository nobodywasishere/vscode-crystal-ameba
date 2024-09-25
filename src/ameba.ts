import { spawn } from 'child_process';
import * as path from 'path';
import { existsSync } from 'fs';
import {
    commands,
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Range,
    TextDocument,
    Uri,
    window,
    workspace
} from 'vscode';
import { AmebaOutput } from './amebaOutput';
import { AmebaConfig, getConfig } from './configuration';
import { Task, TaskQueue } from './taskQueue';

export class Ameba {
    private diag: DiagnosticCollection;
    private taskQueue: TaskQueue;
    public config: AmebaConfig;

    constructor(diagnostics: DiagnosticCollection) {
        this.diag = diagnostics;
        this.taskQueue = new TaskQueue();
        this.config = getConfig();
    }

    public execute(document: TextDocument, virtual: boolean = false): void {
        if (document.languageId !== 'crystal' || document.isUntitled || document.uri.scheme !== 'file') {
            return;
        }

        const args = [this.config.command, document.fileName, '--format', 'json'];
        const dir = workspace.getWorkspaceFolder(document.uri)!.uri.fsPath;
        const configFile = path.join(dir, this.config.configFileName);
        if (existsSync(configFile)) args.push('--config', configFile);

        if (virtual) args.push('--stdin-filename', document.uri.fsPath)

        const task = new Task(document.uri, token => {
            let stdoutArr: string[] = [];
            let stderrArr: string[] = [];

            const proc = spawn(args[0], args.slice(1));

            if (virtual) {
                const documentText: string = document.getText();
                proc.stdin.write(documentText)
            }

            proc.stdout.on('data', (data) => {
                stdoutArr.push(data.toString());
            })

            proc.stderr.on('data', (data) => {
                stderrArr.push(data.toString());
            })

            proc.on('error', (err) => {
                console.error('Failed to start subprocess:', err);
                window.showErrorMessage(`Failed to start Ameba: ${err.message}`)
            })

            proc.on('close', (code) => {
                const stdout = stdoutArr.join('')
                const stderr = stderrArr.join('')

                if (token.isCanceled) return;
                this.diag.delete(document.uri);

                if (code !== 0 && stderr.length) {
                    if ((process.platform == 'win32' && code === 1) || code === 127) {
                        window.showErrorMessage(
                            `Could not execute Ameba file${args[0] === 'ameba' ? '.' : ` at ${args[0]}`}`,
                            'Disable (workspace)'
                        ).then(
                            disable => disable && commands.executeCommand('crystal.ameba.disable'),
                            _ => { }
                        );
                    } else {
                        window.showErrorMessage(stderr);
                    }
                    return;
                }

                let results: AmebaOutput;

                try {
                    results = JSON.parse(stdout);
                } catch (err) {
                    console.error(`Ameba: failed parsing JSON: ${err}`);
                    window.showErrorMessage('Ameba: failed to parse JSON response.');
                    return;
                }

                if (!results.summary.issues_count) return;
                const diagnostics: [Uri, Diagnostic[]][] = [];

                for (let source of results.sources) {
                    if (!source.issues.length) continue;
                    let parsed: Diagnostic[] = [];

                    source.issues.forEach(issue => {
                        let start = issue.location;
                        let end = issue.end_location;

                        if (!end.line || !end.column) {
                            end = start;
                        }

                        const range = new Range(
                            start.line - 1,
                            start.column - 1,
                            end.line - 1,
                            end.column
                        );

                        const diag = new Diagnostic(
                            range,
                            `[${issue.rule_name}] ${issue.message}`,
                            this.parseSeverity(issue.severity)
                        );

                        parsed.push(diag);
                    });

                    diagnostics.push([document.uri, parsed]);
                }

                this.diag.set(diagnostics);
            });

            return () => proc.kill();
        });

        this.taskQueue.enqueue(task);
    }

    private parseSeverity(severity: string): DiagnosticSeverity {
        switch (severity) {
            case 'Error':
                return DiagnosticSeverity.Error;
            case 'Warning':
                return DiagnosticSeverity.Warning;
            case 'Refactoring':
                return DiagnosticSeverity.Hint;
            default:
                return DiagnosticSeverity.Information;
        }
    }

    public clear(document: TextDocument): void {
        let uri = document.uri;
        if (uri.scheme === 'file') {
            this.taskQueue.cancel(uri);
            this.diag.delete(uri);
        }
    }
}
