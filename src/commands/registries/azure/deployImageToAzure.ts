/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebSiteManagementModels } from '@azure/arm-appservice'; // These are only dev-time imports so don't need to be lazy
import { env, Uri, window } from "vscode";
import { IAppServiceWizardContext } from "vscode-azureappservice"; // These are only dev-time imports so don't need to be lazy
import { AzureWizard, AzureWizardExecuteStep, AzureWizardPromptStep, IActionContext, LocationListStep, ResourceGroupListStep } from "vscode-azureextensionui";
import { ext } from "../../../extensionVariables";
import { localize } from "../../../localize";
import { RegistryApi } from '../../../tree/registries/all/RegistryApi';
import { AzureAccountTreeItem } from '../../../tree/registries/azure/AzureAccountTreeItem';
import { azureRegistryProviderId } from '../../../tree/registries/azure/azureRegistryProvider';
import { AzureRegistryTreeItem } from '../../../tree/registries/azure/AzureRegistryTreeItem';
import { DockerHubNamespaceTreeItem } from '../../../tree/registries/dockerHub/DockerHubNamespaceTreeItem';
import { DockerV2RegistryTreeItemBase } from '../../../tree/registries/dockerV2/DockerV2RegistryTreeItemBase';
import { GenericDockerV2RegistryTreeItem } from '../../../tree/registries/dockerV2/GenericDockerV2RegistryTreeItem';
import { registryExpectedContextValues } from '../../../tree/registries/registryContextValues';
import { getRegistryPassword } from '../../../tree/registries/registryPasswords';
import { RegistryTreeItemBase } from '../../../tree/registries/RegistryTreeItemBase';
import { RemoteTagTreeItem } from '../../../tree/registries/RemoteTagTreeItem';
import { nonNullProp } from "../../../utils/nonNull";
import { DockerAssignAcrPullRoleStep } from './DockerAssignAcrPullRoleStep';
import { DockerSiteCreateStep } from './DockerSiteCreateStep';
import { DockerWebhookCreateStep } from './DockerWebhookCreateStep';

export async function deployImageToAzure(context: IActionContext, node?: RemoteTagTreeItem): Promise<void> {
    if (!node) {
        node = await ext.registriesTree.showTreeItemPicker<RemoteTagTreeItem>([registryExpectedContextValues.dockerHub.tag, registryExpectedContextValues.dockerV2.tag], context);
    }

    const vscAzureAppService = await import('vscode-azureappservice');
    vscAzureAppService.registerAppServiceExtensionVariables(ext);

    const wizardContext: IActionContext & Partial<IAppServiceWizardContext> = {
        ...context,
        newSiteOS: vscAzureAppService.WebsiteOS.linux,
        newSiteKind: vscAzureAppService.AppKind.app
    };
    const promptSteps: AzureWizardPromptStep<IAppServiceWizardContext>[] = [];
    // Create a temporary azure account tree item since Azure might not be connected
    const azureAccountTreeItem = new AzureAccountTreeItem(ext.registriesRoot, { id: azureRegistryProviderId, api: RegistryApi.DockerV2 });
    const subscriptionStep = await azureAccountTreeItem.getSubscriptionPromptStep(wizardContext);
    if (subscriptionStep) {
        promptSteps.push(subscriptionStep);
    }

    promptSteps.push(...[
        new vscAzureAppService.SiteNameStep(),
        new ResourceGroupListStep(),
        new vscAzureAppService.AppServicePlanListStep()
    ]);
    LocationListStep.addStep(wizardContext, promptSteps);

    // Get site config before running the wizard so that any problems with the tag tree item are shown at the beginning of the process
    const siteConfig: WebSiteManagementModels.SiteConfig = await getNewSiteConfig(node);
    const executeSteps: AzureWizardExecuteStep<IAppServiceWizardContext>[] = [
        new DockerSiteCreateStep(siteConfig),
        new DockerAssignAcrPullRoleStep(node),
        new DockerWebhookCreateStep(node),
    ];

    const title = localize('vscode-docker.commands.registries.azure.deployImage.title', 'Create new web app');
    const wizard = new AzureWizard(wizardContext, { title, promptSteps, executeSteps });
    await wizard.prompt();
    await wizard.execute();

    const site: WebSiteManagementModels.Site = nonNullProp(wizardContext, 'site');
    const siteUri: string = `https://${site.defaultHostName}`;
    const createdNewWebApp: string = localize('vscode-docker.commands.registries.azure.deployImage.created', 'Successfully created web app "{0}": {1}', site.name, siteUri);
    ext.outputChannel.appendLine(createdNewWebApp);

    const openSite: string = localize('vscode-docker.commands.registries.azure.deployImage.openSite', 'Open Site');
    // don't wait
    /* eslint-disable-next-line @typescript-eslint/no-floating-promises */
    window.showInformationMessage(createdNewWebApp, ...[openSite]).then((selection) => {
        if (selection === openSite) {
            /* eslint-disable-next-line @typescript-eslint/no-floating-promises */
            env.openExternal(Uri.parse(siteUri));
        }
    });
}

async function getNewSiteConfig(node: RemoteTagTreeItem): Promise<WebSiteManagementModels.SiteConfig> {
    const registryTI: RegistryTreeItemBase = node.parent.parent;

    let username: string | undefined;
    let password: string | undefined;
    const appSettings: WebSiteManagementModels.NameValuePair[] = [];

    if (registryTI instanceof AzureRegistryTreeItem) {
        appSettings.push({ name: "DOCKER_ENABLE_CI", value: 'true' });

        // Don't need an image, username, or password--just create an empty web app to assign permissions and then configure with an image
        return {
            acrUseManagedIdentityCreds: true,
            appSettings
        };
    } else if (registryTI instanceof DockerHubNamespaceTreeItem) {
        username = registryTI.parent.username;
        password = await registryTI.parent.getPassword();
    } else if (registryTI instanceof DockerV2RegistryTreeItemBase) {
        appSettings.push({ name: "DOCKER_REGISTRY_SERVER_URL", value: registryTI.baseUrl });

        if (registryTI instanceof GenericDockerV2RegistryTreeItem) {
            username = registryTI.cachedProvider.username;
            password = await getRegistryPassword(registryTI.cachedProvider);
        } else {
            throw new RangeError(localize('vscode-docker.commands.registries.azure.deployImage.unrecognizedNodeTypeA', 'Unrecognized node type "{0}"', registryTI.constructor.name));
        }
    } else {
        throw new RangeError(localize('vscode-docker.commands.registries.azure.deployImage.unrecognizedNodeTypeB', 'Unrecognized node type "{0}"', registryTI.constructor.name));
    }

    if (username && password) {
        appSettings.push({ name: "DOCKER_REGISTRY_SERVER_USERNAME", value: username });
        appSettings.push({ name: "DOCKER_REGISTRY_SERVER_PASSWORD", value: password });
    }

    const linuxFxVersion = `DOCKER|${registryTI.baseImagePath}/${node.repoNameAndTag}`;

    return {
        linuxFxVersion,
        appSettings
    };
}
