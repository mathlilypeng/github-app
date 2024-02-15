import dotenv from 'dotenv'
import fs from 'fs'
import { PubSub } from '@google-cloud/pubsub'
import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'

// Load environment variables from .env file
dotenv.config()

const buildResultTopic = process.env.BOB_THE_BUILDER_RESULT_TOPIC
const cloudProjectId = process.env.CLOUD_PROJECT_ID
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')

function escapeMarkdown(text) {
  // You can add more special characters to this if needed
  return text.replace(/([_*`])/g, '\\$1');
}

function formatBuildResultMessage(buildResult) {
  const formattedMessages = []
  buildResult.history.forEach((historyItem) => {
    const formattedMessage = `Docker File:\n\`\`\`\n${escapeMarkdown(historyItem.docker_file)}\n\`\`\`
    Build Success: ${historyItem.build_success}
    Error Message: ${historyItem.error_logs}`
    formattedMessages.push(formattedMessage)
  })
  return formattedMessages
}


// Handel the build result from Bob the Builder
async function onBobTheBuilderResult(message) {
  const messageStr = message.data.toString('utf8')
  console.log(`Received message: ${messageStr}`);
  const buildResult = JSON.parse(messageStr)
  const octokit = new Octokit({
    authStrategy: createAppAuth, auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: buildResult.issueInfo.installation_id
    }
  });
  const commentBody = formatBuildResultMessage(buildResult).join("\n")
  try {
    await octokit.rest.issues.createComment({
      owner: buildResult.issueInfo.repo_owner,
      repo: buildResult.issueInfo.repo_name,
      issue_number: buildResult.issueInfo.issue_number,
      body: commentBody
    })
  } catch (error) {
    if (error.response) {
      console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
    } else {
      console.error(`Recived error while posting a comment to the issue: ${error.message}`)
    }
  }
  message.ack();
}

async function createBobTheBuilderResultSubscription() {
  const pubsubClient = new PubSub({ cloudProjectId });
  const subscription = pubsubClient.subscription(buildResultTopic)
  // Start listening for messages
  subscription.on('message', onBobTheBuilderResult)
  subscription.on('error', (error) => console.error(`Recived error while listening to ${buildResultSubscription}. Error: ${error}`))
  return subscription
}

export const subscriptions = {
  createBobTheBuilderResultSubscription,
};