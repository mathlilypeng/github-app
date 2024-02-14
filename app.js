import dotenv from 'dotenv'
import fs from 'fs'
import http from 'http'
import { Octokit, App } from 'octokit'
import { createNodeMiddleware } from '@octokit/webhooks'
import { PubSub } from '@google-cloud/pubsub'
import { createAppAuth } from '@octokit/auth-app'

// Load environment variables from .env file
dotenv.config()

// Set configured values
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
const secret = process.env.WEBHOOK_SECRET
const enterpriseHostname = process.env.ENTERPRISE_HOSTNAME
const pubsubTopicName = process.env.PUBSUB_TOPIC_NAME
const cloudProjectId = process.env.CLOUD_PROJECT_ID
const buildResultSubscription = process.env.BUILD_RESULT_SUBSCRIPTION
const installationId = process.env.INSTALLATION_ID


// Create an authenticated Octokit client authenticated as a GitHub App
const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret
  },
  ...(enterpriseHostname && {
    Octokit: Octokit.defaults({
      baseUrl: `https://${enterpriseHostname}/api/v3`
    })
  })
})

// Create a Pub/Sub client
const pubsubClient = new PubSub({ cloudProjectId });

// Publish message to Google PubSub
async function publishMessage(issueInfo) {
  try {
    console.log(`Publishing message to ${pubsubTopicName}.`)
    const messageId = await pubsubClient.topic(pubsubTopicName).publishMessage({ data: Buffer.from(JSON.stringify(issueInfo)) })
    console.log(`Message #${messageId} published.`)
  } catch (error) {
    console.error(`Received error while publishing: ${error.message}`)
  }
}

function escapeMarkdown(text) {
  // You can add more special characters to this if needed
  return text.replace(/([_*`])/g, '\\$1');
}

function formatBuildResultMessage(messageJson) {
  const formattedMessages = []
  messageJson.history.forEach((historyItem) => {
    const formattedMessage = `Docker File:\n\`\`\`\n${escapeMarkdown(historyItem.docker_file)}\n\`\`\`
    Build Success: ${historyItem.build_success}
    Error Message: ${historyItem.error_logs}`
    formattedMessages.push(formattedMessage)
  })
  return formattedMessages
}

// Receive build result from Google PubSub
async function handleMessage(message) {
  const messageStr = message.data.toString('utf8')
  console.log(`Received message: ${messageStr}`);
  const messageJson = JSON.parse(messageStr)
  const octokit = new Octokit({
    authStrategy: createAppAuth, auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: messageJson.issueInfo.installation_id
    }
  });
  const commentBody = formatBuildResultMessage(messageJson).join("\n")
  try {
    await octokit.rest.issues.createComment({
      owner: messageJson.issueInfo.repo_owner,
      repo: messageJson.issueInfo.repo_name,
      issue_number: messageJson.issueInfo.issue_number,
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

// Optional: Get & log the authenticated app's name
const { data } = await app.octokit.request('/app')

// Read more about custom logging: https://github.com/octokit/core.js#logging
app.octokit.log.debug(`Authenticated as '${data.name}'`)

// Subscribe to the "issues.opened" webhook event.
// See https://docs.github.com/en/webhooks/webhook-events-and-payloads for more webhook events.
app.webhooks.on('issues.opened', async ({ octokit, payload }) => {
  const issueInfo = {
    "repo_full_name": payload.repository.full_name,
    "repo_name": payload.repository.name,
    "repo_owner": payload.repository.owner.login,
    "issue_number": payload.issue.number,
    "installation_id": payload.installation.id,
  }

  console.log(`Received a issue reopened event for ${issueInfo.repo_name} #${payload.issue.number}`)

  await publishMessage(issueInfo)

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
})

// Optional: Handle errors
app.webhooks.onError((error) => {
  if (error.name === 'AggregateError') {
    // Log Secret verification errors
    console.log(`Error processing request: ${error.event}`)
  } else {
    console.log(error)
  }
})

const subscription = pubsubClient.subscription(buildResultSubscription)
// Start listening for messages
subscription.on('message', handleMessage)
subscription.on('error', (err) => console.error(`Recived error while listening to ${buildResultSubscription}. Error: ${err}`))

// Launch a web server to listen for GitHub webhooks
const port = process.env.PORT || 3000
const path = '/api/webhook'
const localWebhookUrl = `http://localhost:${port}${path}`

// See https://github.com/octokit/webhooks.js/#createnodemiddleware for all options
const middleware = createNodeMiddleware(app.webhooks, { path })

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`)
  console.log(`Server is subscribing events from Google Pub/Sub at: ${buildResultSubscription}`)
  console.log('Press Ctrl + C to quit.')
})
