import dotenv from 'dotenv'
import { PubSub } from '@google-cloud/pubsub'

// Load environment variables from .env file
dotenv.config()

const bobTheBuilderTopic = process.env.BOB_THE_BUILDER_TOPIC
const cloudProjectId = process.env.CLOUD_PROJECT_ID

// Queue in the Bob the Builder task queue.
async function queueBobTheBuilderTask(issueInfo) {
    const pubsubClient = new PubSub({ cloudProjectId });
    try {
        console.log(`Publishing message to ${bobTheBuilderTopic}.`)
        const messageId = await pubsubClient.topic(bobTheBuilderTopic).publishMessage({ data: Buffer.from(JSON.stringify(issueInfo)) })
        console.log(`Message #${messageId} published.`)
    } catch (error) {
        console.error(`Received error while publishing: ${error.message}`)
    }
}

async function onIssueOpened({ octokit, payload }) {
    const issueInfo = {
        "repo_full_name": payload.repository.full_name,
        "repo_name": payload.repository.name,
        "repo_owner": payload.repository.owner.login,
        "issue_number": payload.issue.number,
        "installation_id": payload.installation.id,
    }

    console.log(`Received an issue opened event for ${issueInfo.repo_name} #${payload.issue.number}`)

    await queueBobTheBuilderTask(issueInfo)

    try {
        await octokit.rest.issues.createComment({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issue_number: payload.issue.number,
            body:
                `We have received your request to generate a docker file for the repository ${issueInfo.repo_name}.
           We will post the generated docker file once it's ready.`
        })
    } catch (error) {
        if (error.response) {
            console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
        } else {
            console.error(`Recived error while posting a comment to the issue: ${error.message}`)
        }
    }
}

export const issueHandlers = {
    onIssueOpened,
};