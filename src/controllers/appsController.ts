import { Request, Response } from 'express';
import pool from '../config/database';
import axios from 'axios';
import dotenv from 'dotenv';
import { filterByDateRange, processWorklogs } from '../services/worklogService';
import { Buffer } from 'buffer';
import { getAuthHeader } from '../utils/auth';

dotenv.config();

const formatIssue = (issue: any) => ({
    id: issue.id,
    key: issue.key,
    IntegrationName: issue.fields.summary,
    Assignee: issue.fields.assignee ? issue.fields.assignee.displayName : null,
    Status: issue.fields.status.name,
    TeamLead: issue.fields.customfield_10147 ? issue.fields.customfield_10147.displayName : "null",
    QA: issue.fields.customfield_10146 ? issue.fields.customfield_10146.displayName : "null",
    Developer: issue.fields.customfield_10145 ? issue.fields.customfield_10145.displayName : "null",
    TimeEstimated: issue.fields.timeestimate ? issue.fields.timeestimate / 3600 : 0,
    Billable: issue.fields.customfield_10206 || "null",
    created: issue.fields.created
});

export const getAppIntegrations = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT project_key FROM reports');
        const projectKeys = result.rows.map(row => row.project_key);

        const auth = getAuthHeader();
        const queryStartDate = req.query.startDate as string;
        const queryEndDate = req.query.endDate as string;
        const currentDate = new Date();
        const defaultStartDate = new Date(currentDate);
        defaultStartDate.setFullYear(currentDate.getFullYear() - 1);
        const startDate = queryStartDate ? new Date(queryStartDate).getTime() : defaultStartDate.getTime();
        const endDate = queryEndDate ? new Date(queryEndDate).getTime() : currentDate.getTime();

        let epicIssues: any[] = [];
        for (const projectKey of projectKeys) {
            let startAt = 0;
            const maxResults = 100;
            let total: number;

            do {
                const response = await axios.post('https://metron-security.atlassian.net/rest/api/3/search', {
                    jql: `project = "${projectKey}" AND issuetype = Epic AND created >= "2024-01-01"`,
                    startAt,
                    maxResults
                }, {
                    headers: {
                        Authorization: auth
                    }
                });

                total = response.data.total;
                startAt += maxResults;

                const issues = response.data.issues.map((issue: any) => formatIssue(issue));
                epicIssues = [...epicIssues, ...issues];
            } while (startAt < total);
        }

        // Process each epic issue
        let epicIssuesProcessed = await Promise.all(epicIssues.map(async (epic: any) => {
            // Fetch worklogs for epic
            const epicWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${epic.id}/worklog`, {
                headers: {
                    Authorization: auth
                }
            });

            const epicWorklogs = epicWorklogResponse.data.worklogs.map((worklog: any) => ({
                comment: worklog.comment,
                created: worklog.created,
                updated: worklog.updated,
                started: worklog.started,
                timeSpentSeconds: worklog.timeSpentSeconds,
                issueId: epic.id
            }));

            let startAt = 0;
            const maxResults = 100;
            let total: number;
            let childIssues: any[] = [];

            do {
                // Fetch child issues of the epic
                const childResponse = await axios.post('https://metron-security.atlassian.net/rest/api/3/search', {
                    jql: `parent=${epic.key}`,
                    startAt,
                    maxResults
                }, {
                    headers: {
                        Authorization: auth
                    }
                });

                total = childResponse.data.total;
                startAt += maxResults;

                const issues = await Promise.all(childResponse.data.issues.map(async (childIssue: any) => {
                    // Fetch worklogs for child issue
                    const childIssueWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${childIssue.id}/worklog`, {
                        headers: {
                            Authorization: auth
                        }
                    });

                    const childIssueWorklogs = childIssueWorklogResponse.data.worklogs.map((worklog: any) => ({
                        comment: worklog.comment,
                        created: worklog.created,
                        updated: worklog.updated,
                        started: worklog.started,
                        timeSpentSeconds: worklog.timeSpentSeconds,
                        issueId: childIssue.id
                    }));

                    // Fetch worklogs for subtasks of the child issue
                    const subtasks = await Promise.all(childIssue.fields.subtasks.map(async (subtask: any) => {
                        const subtaskWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${subtask.id}/worklog`, {
                            headers: {
                                Authorization: auth
                            }
                        });

                        const subtaskWorklogs = subtaskWorklogResponse.data.worklogs.map((worklog: any) => ({
                            comment: worklog.comment,
                            created: worklog.created,
                            updated: worklog.updated,
                            started: worklog.started,
                            timeSpentSeconds: worklog.timeSpentSeconds,
                            issueId: subtask.id
                        }));

                        return {
                            id: subtask.id,
                            key: subtask.key,
                            IntegrationName: subtask.fields.summary,
                            Status: subtask.fields.status.name,
                            worklogs: filterByDateRange(subtaskWorklogs, startDate, endDate),
                            totalWorklogTime: filterByDateRange(subtaskWorklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600
                        };
                    }));

                    return {
                        id: childIssue.id,
                        key: childIssue.key,
                        IntegrationName: childIssue.fields.summary,
                        Status: childIssue.fields.status.statusCategory.name,
                        TimeEstimated: childIssue.fields.timeestimate ? childIssue.fields.timeestimate / 3600 : 0,
                        Billable: childIssue.fields.customfield_10206 || "null",
                        worklogs: filterByDateRange(childIssueWorklogs, startDate, endDate),
                        subtasks,
                        totalWorklogTime: (filterByDateRange(childIssueWorklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600) + subtasks.reduce((acc, subtask) => acc + subtask.totalWorklogTime, 0)
                    };
                }));

                childIssues = [...childIssues, ...issues];
            } while (startAt < total);

            return {
                ...epic,
                worklogs: filterByDateRange(epicWorklogs, startDate, endDate),
                childIssues: processWorklogs(childIssues, startDate, endDate),
                totalWorklogTime: (filterByDateRange(epicWorklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600) + childIssues.reduce((acc, child) => acc + child.totalWorklogTime, 0)
            };
        }));

        res.json(epicIssuesProcessed);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
};

export const getHomeIntegrations = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT project_key FROM reports');
        const projectKeys = result.rows.map(row => row.project_key);

        const auth = getAuthHeader();
        const queryStartDate = req.query.startDate as string;
        const queryEndDate = req.query.endDate as string;
        const currentDate = new Date();
        const defaultStartDate = new Date(currentDate);
        defaultStartDate.setFullYear(currentDate.getFullYear() - 1);
        const startDate = queryStartDate ? new Date(queryStartDate).getTime() : defaultStartDate.getTime();
        const endDate = queryEndDate ? new Date(queryEndDate).getTime() : currentDate.getTime();

        let epicIssues: any[] = [];
        for (const projectKey of projectKeys) {
            let startAt = 0;
            const maxResults = 100;
            let total: number;

            do {
                const response = await axios.post('https://metron-security.atlassian.net/rest/api/3/search', {
                    jql: `project = "${projectKey}" AND issuetype = Epic AND created >= "2024-01-01"`,
                    startAt,
                    maxResults
                }, {
                    headers: {
                        Authorization: auth
                    }
                });

                total = response.data.total;
                startAt += maxResults;

                const issues = response.data.issues.map((issue: any) => formatIssue(issue));
                epicIssues = [...epicIssues, ...issues];
            } while (startAt < total);
        }

        let epicIssuesProcessed = await Promise.all(epicIssues.map(async (epic: any) => {
            const epicWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${epic.id}/worklog`, {
                headers: {
                    Authorization: auth
                }
            });

            const epicWorklogs = epicWorklogResponse.data.worklogs.map((worklog: any) => ({
                comment: worklog.comment,
                created: worklog.created,
                updated: worklog.updated,
                started: worklog.started,
                timeSpentSeconds: worklog.timeSpentSeconds,
                issueId: epic.id
            }));

            let startAt = 0;
            const maxResults = 100;
            let total: number;
            let childIssues: any[] = [];

            do {
                const childResponse = await axios.post('https://metron-security.atlassian.net/rest/api/3/search', {
                    jql: `parent=${epic.key}`,
                    startAt,
                    maxResults
                }, {
                    headers: {
                        Authorization: auth
                    }
                });

                total = childResponse.data.total;
                startAt += maxResults;

                const issues = await Promise.all(childResponse.data.issues.map(async (childIssue: any) => {
                    const childIssueWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${childIssue.id}/worklog`, {
                        headers: {
                            Authorization: auth
                        }
                    });

                    const childIssueWorklogs = childIssueWorklogResponse.data.worklogs.map((worklog: any) => ({
                        comment: worklog.comment,
                        created: worklog.created,
                        updated: worklog.updated,
                        started: worklog.started,
                        timeSpentSeconds: worklog.timeSpentSeconds,
                        issueId: childIssue.id
                    }));

                    const subtasks = await Promise.all(childIssue.fields.subtasks.map(async (subtask: any) => {
                        const subtaskWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${subtask.id}/worklog`, {
                            headers: {
                                Authorization: auth
                            }
                        });

                        const subtaskWorklogs = subtaskWorklogResponse.data.worklogs.map((worklog: any) => ({
                            comment: worklog.comment,
                            created: worklog.created,
                            updated: worklog.updated,
                            started: worklog.started,
                            timeSpentSeconds: worklog.timeSpentSeconds,
                            issueId: subtask.id
                        }));

                        return {
                            id: subtask.id,
                            key: subtask.key,
                            IntegrationName: subtask.fields.summary,
                            Status: subtask.fields.status.name,
                            worklogs: filterByDateRange(subtaskWorklogs, startDate, endDate),
                            totalWorklogTime: filterByDateRange(subtaskWorklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600
                        };
                    }));

                    return {
                        id: childIssue.id,
                        key: childIssue.key,
                        IntegrationName: childIssue.fields.summary,
                        Status: childIssue.fields.status.statusCategory.name,
                        TimeEstimated: childIssue.fields.timeestimate ? childIssue.fields.timeestimate / 3600 : 0,
                        Billable: childIssue.fields.customfield_10206 || "null",
                        worklogs: filterByDateRange(childIssueWorklogs, startDate, endDate),
                        subtasks,
                        totalWorklogTime: (filterByDateRange(childIssueWorklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600) + subtasks.reduce((acc, subtask) => acc + subtask.totalWorklogTime, 0)
                    };
                }));

                childIssues = [...childIssues, ...issues];
            } while (startAt < total);

            return {
                ...epic,
                worklogs: filterByDateRange(epicWorklogs, startDate, endDate),
                childIssues: processWorklogs(childIssues, startDate, endDate),
                totalWorklogTime: (filterByDateRange(epicWorklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600) + childIssues.reduce((acc, child) => acc + child.totalWorklogTime, 0)
            };
        }));

        res.json(epicIssuesProcessed);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
};
