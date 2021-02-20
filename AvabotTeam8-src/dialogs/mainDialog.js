// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const path = require('path');
const axios = require('axios');
const fs = require('fs');
const fse = require("fs-extra");
var FormData = require("form-data");
const {
    AttachmentPrompt,
    ChoiceFactory,
    ChoicePrompt,
    ComponentDialog,
    ConfirmPrompt,
    DialogSet,
    DialogTurnStatus,
    TextPrompt,
    WaterfallDialog
} = require('botbuilder-dialogs');
const { AnswerDialog, ANSWER_DIALOG } = require('./answerDialog');
const { DocDialog, DOC_DIALOG } = require('./docDialog');

const ATTACHMENT_PROMPT = 'ATTACHMENT_PROMPT';
const CHOICE_PROMPT = 'CHOICE_PROMPT';
const CONFIRM_PROMPT = 'CONFIRM_PROMPT';
const USER_PROFILE = 'USER_PROFILE';
const WATERFALL_DIALOG = 'WATERFALL_DIALOG';

class MainDialog extends ComponentDialog {
    constructor(userState) {
        super('mainDialog');

        this.userProfile = userState.createProperty(USER_PROFILE);

        this.addDialog(new AnswerDialog());
        this.addDialog(new DocDialog(this.initialDialogId));
        this.addDialog(new TextPrompt('TextPrompt'));
        this.addDialog(new ChoicePrompt(CHOICE_PROMPT));
        this.addDialog(new ConfirmPrompt(CONFIRM_PROMPT));
        this.addDialog(new AttachmentPrompt(ATTACHMENT_PROMPT, this.promptValidator));

        this.addDialog(new WaterfallDialog(WATERFALL_DIALOG, [
            this.startStep.bind(this),
            this.chooseStep.bind(this),
            this.docStep.bind(this),
            this.repeatStep.bind(this)
        ]));

        this.initialDialogId = WATERFALL_DIALOG;
    }

    /**
     * The run method handles the incoming activity (in the form of a TurnContext) and passes it through the dialog system.
     * If no dialog is active, it will start the default dialog.
     * @param {*} turnContext
     * @param {*} accessor
     */
    async run(turnContext, accessor) {
        const dialogSet = new DialogSet(accessor);
        dialogSet.add(this);

        const dialogContext = await dialogSet.createContext(turnContext);
        const results = await dialogContext.continueDialog();
        if (results.status === DialogTurnStatus.empty) {
            await dialogContext.beginDialog(this.id);
        }
    }

    async startStep(step) {
        // WaterfallStep always finishes with the end of the Waterfall or with another dialog; here it is a Prompt Dialog.
        // Running a prompt here means the next WaterfallStep will be run when the user's response is received.
        const msg = step.options.restartMsg ? step.options.restartMsg : 'What can I do for you?';
        return await step.prompt(CHOICE_PROMPT, {
            prompt: msg,
            choices: ChoiceFactory.toChoices(['ask a question', 'process a document', , 'process an image'])
        });
    }

    async chooseStep(step) {
        const choice = step.result.value;
        if (choice == 'ask a question') {
            return await step.beginDialog(ANSWER_DIALOG);
        }
        else if (choice == 'process a document') {
            var promptOptions = {
                prompt: 'Please attach a document in pdf.',
                retryPrompt: 'That was not a document that I can help, please try again.'
            };

            return await step.prompt(ATTACHMENT_PROMPT, promptOptions);
        }
        else {
            var promptOptions = {
                prompt: 'Please attach an image.',
                retryPrompt: 'That was not a document that I can help, please try again.'
            };

            return await step.prompt(ATTACHMENT_PROMPT, promptOptions);
        }
    }

    async docStep(step) {
        if (step.result && step.result.length > 0) {
            console.log(step.result[0].contentType);
            var type = step.result[0].contentType;
            if (type === 'application/pdf') {
                var path = await this.handleIncomingAttachment(step.context);
                console.log('path: ' + path);
                var req_results = await this.sendReq(path);
                return await step.beginDialog(DOC_DIALOG, { sum: req_results[0], query: req_results[1], filepath: path });
            }
            else {
                await this.handleIncomingAttachment(step.context);
                return await step.context.sendActivity('More functions to be updating...');
            }

        }
        else {
            return await step.endDialog();
        }

    }


    async repeatStep(step) {
        return await step.replaceDialog(this.initialDialogId, { restartMsg: 'What else can I do for you?' });
    }

    async sendReq(path) {
        var form1 = new FormData();
        form1.append("file", fse.createReadStream(path));
        var form2 = new FormData();
        form2.append("file", fse.createReadStream(path));

        let reqArr = [axios({
            method: "post",
            url: "https://textsumapi.azurewebsites.net/api/textsumapi",
            data: form1,
            headers: form1.getHeaders()
        }), axios({
            method: "post",
            url: "http://51.11.182.5:5000",
            data: form2,
            headers: form2.getHeaders()
        })];
        var output = [];
        await Promise.allSettled(reqArr).then(results => {
            results.forEach(result => {
                console.log(result.status);
                if (result.status == 'fulfilled') {
                    output.push(result.value.data);
                    console.log('first: '+result.value.data);
                } else {
                    output.push(0);
                }

            })

        })

        console.log("完成啦！");
        console.log(output);
        return output;
    }

    async handleIncomingAttachment(turnContext) {
        // Prepare Promises to download each attachment and then execute each Promise.
        const promises = await turnContext.activity.attachments.map(this.downloadAttachmentAndWrite);
        const successfulSaves = await Promise.all(promises);

        // Replies back to the user with information about where the attachment is stored on the bot's server,
        // and what the name of the saved file is.
        async function replyForReceivedAttachments(localAttachmentData) {
            if (localAttachmentData) {
                // Because the TurnContext was bound to this function, the bot can call
                // `TurnContext.sendActivity` via `this.sendActivity`;
                await this.sendActivity(`Attachment "${localAttachmentData.fileName}" ` +
                    `has been received.`);

            } else {
                await this.sendActivity('Attachment was not successfully saved to disk.');
            }
            return localAttachmentData.localPath
        }

        // Prepare Promises to reply to the user with information about saved attachments.
        // The current TurnContext is bound so `replyForReceivedAttachments` can also send replies.
        const replyPromises = successfulSaves.map(replyForReceivedAttachments.bind(turnContext));
        let r = await Promise.all(replyPromises).then(result => result[0]);
        return r

    }

    async downloadAttachmentAndWrite(attachment) {
        var name = 'text.' + attachment.contentType.toString().split('/')[1];
        console.log(name);
        // Retrieve the attachment via the attachment's contentUrl.
        const url = attachment.contentUrl;

        // Local file path for the bot to save the attachment.
        const localFileName = path.join(__dirname, name);

        try {
            // arraybuffer is necessary for images
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            // If user uploads JSON file, this prevents it from being written as "{"type":"Buffer","data":[123,13,10,32,32,34,108..."
            if (response.headers['content-type'] === 'application/json') {
                response.data = JSON.parse(response.data, (key, value) => {
                    return value && value.type === 'Buffer' ? Buffer.from(value.data) : value;
                });
            }
            fs.writeFile(localFileName, response.data, (fsError) => {
                if (fsError) {
                    throw fsError;
                }
            });
        } catch (error) {
            console.error(error);
            return undefined;
        }
        // If no error was thrown while writing to disk, return the attachment's name
        // and localFilePath for the response back to the user.
        return {
            fileName: attachment.name,
            localPath: localFileName
        };
    }



    async promptValidator(promptContext) {
        if (promptContext.recognized.succeeded) {
            var docType = promptContext.options.prompt;
            var attachments = promptContext.recognized.value;
            var validDoc = [];

            attachments.forEach(attachment => {
                if (docType === 'Please attach a document in pdf.' && attachment.contentType === 'application/pdf') { //|| attachment.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'|| attachment.contentType === 'application/msword'
                    validDoc.push(attachment);
                }
                else if (docType === 'Please attach an image.' && (attachment.contentType === 'image/jpeg' || attachment.contentType === 'image/png')) {
                    validDoc.push(attachment);
                }
            });

            promptContext.recognized.value = validDoc;

            // If none of the attachments are valid images, the retry prompt should be sent.
            return !!validDoc.length;
        } else {
            await promptContext.context.sendActivity('No attachments received, please try again.');

            // We can return true from a validator function even if Recognized.Succeeded is false.
            return false;
        }
    }

}

module.exports.MainDialog = MainDialog;