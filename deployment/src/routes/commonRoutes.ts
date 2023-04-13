import {addDoc, getCollection, getDoc, setDoc, uploadModel} from "../utility/firebase";
import {
    fillDeploymentTemplate,
    fillScreenerTemplate,
    deployModel,
    startScreenerDeployment, ensureNamespace
} from "../utility/kubernetes";
import path from "path";
import {buildDocker} from "../functions/docker-build";
import fs from "fs";
import {wipe, killPod, killJob} from "../utility/utils";
const { v4: uuidv4 } = require('uuid');
import {createHash} from "crypto";

let getPlans = async function(folder: string) {
    const path = `/plans/${folder}/plans`

    const result: { [p: string]: any; id: string }[] = await getCollection(path)

    let formattedPlans: {[index: string]: any} = {};


    result.forEach(plan => {
        let name = plan['name']
        let cpu = plan['cpu']
        let ram = plan['ram']
        formattedPlans[name] = {
            'cpu': cpu,
            'ram': ram
        }
    })
    return formattedPlans
}


let postToken = async function (uid: string, deploymentToken: string, projectId: string, read: boolean, write: boolean, name: string, autogenerated: boolean = false) {
    // This will add valid tokens for each version allowing the model events API to authenticate by token
    let tokenData: any = {tokens: {}}

    // Hash the token here for the db
    const hashedToken = createHash('sha256').update(deploymentToken).digest('hex')

    tokenData.tokens[hashedToken] = {
        projectId: projectId,
        write: write,
        read: read,
        name: name,
        autogenerated: autogenerated,
        createdBy: uid,
        timestamp: new Date().getTime()/1000
    }
    setDoc(`apiKeys/${projectId}`, tokenData)

    return [ projectId, deploymentToken ]
}

/*
Take an existing uploaded model and send it to the kubernetes cluster to actually be run
@param projectId: The projectId identifying the project in which the model should be placed in
@param modelId: The id identifying the particular uploaded model to run
@param imgUrl: The url pointing to the image to run. This was stored when it was uploaded
@param versionId: The exact version tag to deploy. Also stored when it was uploaded
 */
let run = async function(projectId: string, userId: string,
                         planFolder: string , plan: string,
                         modelId: string, versionId: string,
                         backtesting: boolean, screenerSchedule: string = undefined,
                         backtestingArgs: JSON = undefined,
                         backtestDescription: string = undefined) {
    let plans = await getPlans(planFolder)

    const deploymentMB = plans[plan].ram
    const deploymentMilliCPU = plans[plan].cpu

    // Always make sure the namespace is created
    await ensureNamespace(projectId)

    let deploymentToken;

    const versionDetails = await getDoc(`projectSecure/${projectId}/models/${modelId}/versions/${versionId}`)

    const type = (await getDoc(`projects/${projectId}/models/${modelId}`)).type

    if (!versionDetails.exists) {
        return {error: "Version ID not found"}
    }

    let imgUrl = versionDetails.imgUrl

    // Backtesting has an entirely different flow than running live
    if (backtesting) {
        let args: string = undefined

        if (backtestingArgs !== undefined) {
            args = JSON.stringify(backtestingArgs)
        }

        if (type != 'strategy') {
            return {error: 'The model is not of type strategy.'}
        }

        const backtestDetails = await addDoc(`projects/${projectId}/models/${modelId}/backtests`, {
            args: backtestingArgs,
            description: backtestDescription,
            runBy: userId,
            version: versionId,
            deployedAt: Date.now() / 1000
        })

        let deploymentResults = fillDeploymentTemplate(imgUrl, versionId, deploymentMB, deploymentMilliCPU, backtesting, projectId, modelId, userId, args, backtestDetails.id);

        const deploymentTemplate = deploymentResults[0]
        deploymentToken = deploymentResults[1]

        const writeSecure = setDoc(`/projectSecure/${projectId}/models/${modelId}/backtests/${backtestDetails.id}`, {
            kubernetesName: deploymentResults[0].metadata.name
        })

        const deployment = deployModel(projectId, deploymentTemplate)

        await Promise.all([writeSecure, deployment])
    }
    // Running live is designed to reduce the chances of having a double deployment
    else {
        let validPromises = []

        // Wiping is type agnostic
        validPromises.push(wipe(projectId, modelId))


        if (type == 'strategy') {
            const secureDoc = await getDoc(`/projectSecure/${projectId}/models/${modelId}`)
            if ('kubernetesName' in secureDoc) {
                validPromises.push(killPod(projectId, secureDoc.kubernetesName))
            }

            validPromises.push(wipe(projectId, modelId));

            // Make sure to pass along the backtesting arguments as well as the backtesting enable/disable
            let deploymentResults = fillDeploymentTemplate(imgUrl, versionId, deploymentMB, deploymentMilliCPU, backtesting, projectId, modelId, userId);

            const deploymentTemplate = deploymentResults[0]
            deploymentToken = deploymentResults[1]

            // create deployment by sending API call to kubernetes cluster
            validPromises.push(deployModel(projectId, deploymentTemplate));

            validPromises.push(setDoc(`/projectSecure/${projectId}/models/${modelId}`, {
                deployedVersion: versionId,
                kubernetesName: deploymentTemplate.metadata.name
            }))

            validPromises.push(setDoc(`/projects/${projectId}/models/${modelId}`, {
                deployedBy: userId,
                deployedVersion: versionId,
                deployedAt: Date.now() / 1000
            }))
        } else if (type == 'screener') {
            const secureDoc = await getDoc(`/projectSecure/${projectId}/models/${modelId}`)
            if ('kubernetesName' in secureDoc) {
                validPromises.push(killJob(projectId, secureDoc.kubernetesName))
            }

            validPromises.push(wipe(projectId, modelId));

            // Make sure to pass along the backtesting arguments as well as the backtesting enable/disable
            let deploymentResults = fillScreenerTemplate(imgUrl, versionId, deploymentMB, deploymentMilliCPU, projectId, modelId, userId, screenerSchedule);

            const deploymentTemplate = deploymentResults[0]
            deploymentToken = deploymentResults[1]

            // create deployment by sending API call to kubernetes cluster
            validPromises.push(startScreenerDeployment(projectId, deploymentTemplate));

            validPromises.push(setDoc(`/projectSecure/${projectId}/models/${modelId}`, {
                deployedVersion: versionId,
                kubernetesName: deploymentTemplate.metadata.name,
                schedule: screenerSchedule
            }))

            validPromises.push(setDoc(`/projects/${projectId}/models/${modelId}`, {
                deployedBy: userId,
                deployedVersion: versionId,
                deployedAt: Date.now() / 1000,
                schedule: screenerSchedule
            }))
        } else {
            return {error: 'Invalid type'}
        }

        await Promise.all(validPromises)
    }

    await postToken(userId, deploymentToken, projectId, false, true, `Token for model ${modelId}, version ${versionId}`, true)
}


let backtest = async function() {

}

/*
Parsing & uploading for a user who uploads a file onto the server
@param file: The file object created by express
@param description: The user created description of their model
@param projectId: The identifier for the project in which to place the model into
@param name: A commonly used user-created identifier for the project
 */
let upload = async function(file: { path: string; destination: string; filename: string; },
                            pythonVersion: string,
                            versionDescription: string,
                            projectId: string,
                            modelId: string,
                            type: string,
                            userId: string) {
    let is_premium: boolean = true;

    // Upload model zip file to bucket
    const modelFilePath = path.resolve(file.path);
    // Must turn artifacts into artifacts.dev (sad)
    let bucketName;
    if (process.env.PROJECT_ID == 'blankly-dev') {
        bucketName = 'blankly-dev'
    } else {
        bucketName = 'artifacts.blankly-6ada5.appspot.com'
    }

    let { url, refName, bucket } = await uploadModel(modelFilePath, bucketName);

    if (!is_premium) {
        // delete older zip(s)
    }

    const model = await getDoc(`projects/${projectId}/models/${modelId}`)

    // Check first if it exists
    if(!model.exists) {
        return {error: 'This modelId was not found under this project.'}
    }

    // Check second if the type is correct
    if (model.type !== undefined) {
        if (!(model.type === type)) {
            return {error: 'The specified type does not match the model type.'}
        }
    }

    // Generate the version ID
    const versionId = uuidv4()

    // Await these three promises
    const createdAt = Date.now()/1000
    // Docker Building and Upload to Artifact Registry
    const dockerBuildPromise = buildDocker(file.destination, file.filename, projectId, modelId, versionId, pythonVersion);

    // promise 1
    const usersPromise = setDoc(`/projects/${projectId}/models/${modelId}/versions/${versionId}`, {
        createdAt: createdAt,
        versionDescription: versionDescription,
        uploadedBy: userId
    });

    // Get Artifact Registry img URL and store into Firestore
    const imgUrl = `us-docker.pkg.dev/${process.env.PROJECT_ID}/models/${projectId.toLowerCase()}-${modelId.toLowerCase()}:${versionId.toLowerCase()}`
    const securePromise = setDoc(`/projectSecure/${projectId}/models/${modelId}/versions/${versionId}`, {
        bucketName: bucket,
        createdAt: createdAt,
        versionDescription: versionDescription,
        imgUrl: imgUrl,
        uploadedBy: userId
    })

    // Finish all three at the same time
    await Promise.all([usersPromise, securePromise, dockerBuildPromise])

    // delete temporary file created
    try {
        fs.unlinkSync(modelFilePath);
    } catch (err) {
        console.error(err);
    }
    
    return {
        status: 'success',
        versionId: versionId,
        createdAt: createdAt,
        projectId: projectId,
        versionDescription: versionDescription,
        imgUrl: imgUrl,
        modelId: modelId
    }
}

export {
    getPlans,
    run,
    upload,
    backtest,
    postToken
};