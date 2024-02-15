import dotenv from 'dotenv'
import { PubSub } from '@google-cloud/pubsub'

// Load environment variables from .env file
dotenv.config()

const bobTheBuilderTopic = process.env.BOB_THE_BUILDER_TOPIC
const patchGenerationTaskTopic = process.env.PATCH_GENERATION_TASK_TOPIC
const cloudProjectId = process.env.CLOUD_PROJECT_ID

async function publishMessage(pubsubTopic, jsonData) {
    const pubsubClient = new PubSub({ cloudProjectId });
    try {
        console.log(`Publishing message to ${pubsubTopic}.`)
        const messageId = await pubsubClient.topic(pubsubTopic).publishMessage({ data: Buffer.from(JSON.stringify(jsonData)) })
        console.log(`Message #${messageId} published.`)
    } catch (error) {
        console.error(`Received error while publishing: ${error.message}`)
    }
}

async function createComment(octokit, owner, repo, issueNumber, commentBody) {
    try {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: issueNumber,
            body: commentBody
        })
    } catch (error) {
        if (error.response) {
            console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
        } else {
            console.error(`Recived error while posting a comment to the issue: ${error.message}`)
        }
    }
}

async function onIssueOpened({ octokit, payload }) {
    const issueInfo = {
        "repo_full_name": payload.repository.full_name,
        "repo_name": payload.repository.name,
        "repo_owner": payload.repository.owner.login,
        "issue_title": payload.issue.title,
        "issue_number": payload.issue.number,
        "installation_id": payload.installation.id,
        "problem_statement": payload.issue.title,
    }

    console.log(`Received an issue opened event for ${issueInfo.repo_name} #${payload.issue.number}`)

    if (payload.issue.title.toLowerCase().includes("docker file")) {
        await publishMessage(bobTheBuilderTopic, issueInfo)
        const comment = `We have received your request to generate a docker file for the repository ${issueInfo.repo_name}.
        We will post the generated docker file once it's ready.`
        createComment(octokit, payload.repository.owner.login, issueInfo.repo_name, payload.issue.number, comment)
    } else {
        await publishMessage(patchGenerationTaskTopic, issueInfo)
        const comment = `We have received your issue for the repository ${issueInfo.repo_name}. We've started working on this and will provide updates as we progress.`
        createComment(octokit, payload.repository.owner.login, issueInfo.repo_name, payload.issue.number, comment)
    }
}

export const issueHandlers = {
    onIssueOpened,
};