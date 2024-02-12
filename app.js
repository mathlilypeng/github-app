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
async function publishMessage(message) {
  try {
    console.log(`Publishing message to ${pubsubTopicName}.`)
    const messageId = await pubsubClient.topic(pubsubTopicName).publishMessage({ data: Buffer.from(message) })
    console.log(`Message #${messageId} published.`)
  } catch (error) {
    console.error(`Received error while publishing: ${error.message}`)
  }
}

function escapeMarkdown(text) {
  // You can add more special characters to this if needed
  return text.replace(/([_*`])/g, '\\$1');
}

function formatBuildResultMessage(rawResponseData) {
  const responseData = rawResponseData.toString('utf8')
  console.log("Raw data:", responseData);
  const messages = JSON.parse(responseData)
  const formattedMessages = []
  messages.forEach((message) => {
    console.log("Message:", message);
    console.log("Dockerfile:", message.docker_file);
    console.log("Build Success:", message.build_success);
    console.log("Error Logs:", message.error_logs);
    const formattedMessage = `Docker File:\n\`\`\`\n${escapeMarkdown(message.docker_file)}\n\`\`\`
    Build Success: ${message.build_success}
    Error Message: ${message.error_logs}`
    formattedMessages.push(formattedMessage)
  })
  return formattedMessages
}

// Receive build result from Google PubSub
async function handleMessage(message) {
  console.log(`Received message: ${message.data}`);
  // Create an Octokit instance authenticated with your personal access token
  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  })
  const octokit = new Octokit({
    authStrategy: createAppAuth, auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: installationId
    }
  });
  const commentBody = formatBuildResultMessage(message.data).join("\n")
  try {
    await octokit.rest.issues.createComment({
      owner: "mathlilypeng",
      repo: "pubsub-hello-world",
      issue_number: 6,
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
  let repo_name = payload.repository.full_name
  console.log(`Received a issue reopened event for ${repo_name} #${payload.issue.number}`)

  await publishMessage(repo_name)

  try {
    await octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body:
        `We have received your request to generate a docker file for the repository ${repo_name}.
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
